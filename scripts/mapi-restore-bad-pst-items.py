import argparse
import csv
import datetime as dt
import os

import win32com.client
from win32com.mapi import mapi, mapitags


PR_ENTRYID = mapitags.PR_ENTRYID
PR_MESSAGE_FLAGS = mapitags.PR_MESSAGE_FLAGS
PR_SUBJECT_W = mapitags.PR_SUBJECT_W
PR_INTERNET_MESSAGE_ID_A = mapitags.PROP_TAG(mapitags.PT_STRING8, 0x1035)
PR_INTERNET_MESSAGE_ID_W = mapitags.PROP_TAG(mapitags.PT_UNICODE, 0x1035)

MSGFLAG_UNSENT = 0x00000008

SKIP_SOURCE_FOLDERS = {"Deleted Messages", "Drafts", "Junk", "보낼 편지함"}


def mapi_hex(entry_id):
    return bytes(entry_id).hex().upper()


def normalize_message_id(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("ascii", "ignore")
    text = str(value).strip().lower()
    if text.startswith("<"):
        text = text[1:]
    if text.endswith(">"):
        text = text[:-1]
    return text.strip()


def row_dict(row):
    return {tag: value for tag, value in row}


def row_value(row, *tags):
    data = row_dict(row)
    for tag in tags:
        if tag in data:
            return data[tag]
    return None


def mail_root():
    return "D:\\" + chr(0xBA54) + chr(0xC77C)


def pst_path():
    return os.path.join(mail_root(), "2026.pst")


def inbox_name():
    return "".join([chr(0xBC1B), chr(0xC740), " ", chr(0xBA54), chr(0xC77C), chr(0xD568)])


def sent_name():
    return "".join([chr(0xBCF4), chr(0xB0B8), " ", chr(0xBA54), chr(0xC77C), chr(0xD568)])


def open_store(session, store_hex):
    table = session.GetMsgStoresTable(0)
    table.SetColumns((PR_ENTRYID,), 0)
    while True:
        rows = table.QueryRows(20, 0)
        if not rows:
            break
        for row in rows:
            entry_id = row[0][1]
            if mapi_hex(entry_id) == store_hex.upper():
                return session.OpenMsgStore(0, entry_id, None, mapi.MDB_WRITE | mapi.MAPI_BEST_ACCESS)
    raise RuntimeError("MAPI store not found")


def table_rows(folder):
    table = folder.GetContentsTable(0)
    table.SetColumns(
        (
            PR_ENTRYID,
            PR_MESSAGE_FLAGS,
            PR_SUBJECT_W,
            PR_INTERNET_MESSAGE_ID_A,
            PR_INTERNET_MESSAGE_ID_W,
        ),
        0,
    )
    while True:
        rows = table.QueryRows(200, 0)
        if not rows:
            break
        for row in rows:
            yield row


def get_targets(outlook):
    ns = outlook.GetNamespace("MAPI")
    pst = pst_path()
    pst_store = None
    for store in ns.Stores:
        if store.FilePath == pst:
            pst_store = store
            break
    if pst_store is None:
        raise RuntimeError(f"Outlook PST store not found: {pst}")

    pst_root = pst_store.GetRootFolder()
    naver_root = ns.Folders.Item("daelimsm@naver.com")
    return {
        "pst_store": pst_store,
        "pst_folders": {
            "INBOX": pst_root.Folders.Item(inbox_name()),
            "Sent_Messages": pst_root.Folders.Item(sent_name()),
        },
        "naver_root": naver_root,
    }


def collect_bad_and_good(folder):
    bad = []
    good_mids = set()
    for row in table_rows(folder):
        flags = int(row_value(row, PR_MESSAGE_FLAGS) or 0)
        mid = normalize_message_id(row_value(row, PR_INTERNET_MESSAGE_ID_A, PR_INTERNET_MESSAGE_ID_W))
        if not mid:
            continue
        entry_id = row_value(row, PR_ENTRYID)
        subject = row_value(row, PR_SUBJECT_W) or ""
        if flags & MSGFLAG_UNSENT:
            bad.append({"entry_id": entry_id, "mid": mid, "flags": flags, "subject": subject})
        else:
            good_mids.add(mid)
    return bad, good_mids


def source_folder_names(label, naver_root):
    if label == "Sent_Messages":
        return {"Sent Messages"}
    names = set()
    for index in range(1, naver_root.Folders.Count + 1):
        name = naver_root.Folders.Item(index).Name
        if name in SKIP_SOURCE_FOLDERS or name == "Sent Messages":
            continue
        names.add(name)
    return names


def build_source_index(session, naver_root, folder_names):
    store_cache = {}
    index = {}
    for index_no in range(1, naver_root.Folders.Count + 1):
        folder_oom = naver_root.Folders.Item(index_no)
        if folder_oom.Name not in folder_names:
            continue
        try:
            store = store_cache.get(folder_oom.StoreID)
            if store is None:
                store = open_store(session, folder_oom.StoreID)
                store_cache[folder_oom.StoreID] = store
            folder = store.OpenEntry(bytes.fromhex(folder_oom.EntryID), None, mapi.MAPI_BEST_ACCESS)
            for row in table_rows(folder):
                mid = normalize_message_id(row_value(row, PR_INTERNET_MESSAGE_ID_A, PR_INTERNET_MESSAGE_ID_W))
                if not mid or mid in index:
                    continue
                flags = int(row_value(row, PR_MESSAGE_FLAGS) or 0)
                if flags & MSGFLAG_UNSENT:
                    continue
                index[mid] = {
                    "store": store,
                    "entry_id": row_value(row, PR_ENTRYID),
                    "folder": folder_oom.Name,
                    "flags": flags,
                    "subject": row_value(row, PR_SUBJECT_W) or "",
                }
        except Exception:
            continue
    return index


def verify_message(message, expected_mid):
    _, props = message.GetProps(
        (PR_MESSAGE_FLAGS, PR_INTERNET_MESSAGE_ID_A, PR_INTERNET_MESSAGE_ID_W, PR_ENTRYID, PR_SUBJECT_W),
        0,
    )
    props = row_dict(props)
    flags = int(props.get(PR_MESSAGE_FLAGS) or 0)
    mid = normalize_message_id(props.get(PR_INTERNET_MESSAGE_ID_A) or props.get(PR_INTERNET_MESSAGE_ID_W))
    return {
        "ok": (flags & MSGFLAG_UNSENT) == 0 and mid == expected_mid,
        "flags": flags,
        "mid": mid,
        "entry_id": props.get(PR_ENTRYID),
        "subject": props.get(PR_SUBJECT_W) or "",
    }


def log_path():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "logs")
    os.makedirs(path, exist_ok=True)
    return os.path.join(path, "mapi-pst-item-restore-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".csv")


def run(apply, folder_filter, limit):
    mapi.MAPIInitialize(None)
    session = mapi.MAPILogonEx(0, "", "", mapi.MAPI_EXTENDED | mapi.MAPI_USE_DEFAULT | mapi.MAPI_BEST_ACCESS)
    rows = []
    scanned = bad_count = restored = deleted_bad = missing_source = skipped_existing_good = errors = 0
    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
        targets = get_targets(outlook)
        pst_store = open_store(session, targets["pst_store"].StoreID)

        labels = ["INBOX", "Sent_Messages"] if folder_filter == "All" else [folder_filter]
        for label in labels:
            target_folder_oom = targets["pst_folders"][label]
            target_folder = pst_store.OpenEntry(bytes.fromhex(target_folder_oom.EntryID), None, mapi.MAPI_MODIFY | mapi.MAPI_BEST_ACCESS)
            bad_items, good_mids = collect_bad_and_good(target_folder)
            if not bad_items:
                continue
            source_index = build_source_index(session, targets["naver_root"], source_folder_names(label, targets["naver_root"]))

            for bad in bad_items:
                if limit and restored + skipped_existing_good + missing_source + errors >= limit:
                    break
                scanned += 1
                bad_count += 1
                status = "dry-run"
                new_flags = ""
                source_folder = ""
                if bad["mid"] in good_mids:
                    skipped_existing_good += 1
                    status = "existing-good-delete-pending" if apply else "existing-good"
                    if apply:
                        target_folder.DeleteMessages((bad["entry_id"],), 0, None, 0)
                        deleted_bad += 1
                        status = "deleted-bad-existing-good"
                elif bad["mid"] not in source_index:
                    missing_source += 1
                    status = "source-missing"
                elif apply:
                    try:
                        source_info = source_index[bad["mid"]]
                        source_folder = source_info["folder"]
                        source_message = source_info["store"].OpenEntry(source_info["entry_id"], None, mapi.MAPI_BEST_ACCESS)
                        new_message = target_folder.CreateMessage(None, 0)
                        source_message.CopyTo([], [], 0, None, mapi.IID_IMAPIProp, new_message, 0)
                        new_message.SaveChanges(mapi.KEEP_OPEN_READWRITE)
                        result = verify_message(new_message, bad["mid"])
                        new_flags = result["flags"]
                        if not result["ok"]:
                            target_folder.DeleteMessages((result["entry_id"],), 0, None, 0)
                            errors += 1
                            status = "new-copy-verify-failed"
                        else:
                            target_folder.DeleteMessages((bad["entry_id"],), 0, None, 0)
                            restored += 1
                            deleted_bad += 1
                            good_mids.add(bad["mid"])
                            status = "restored"
                    except Exception as exc:
                        errors += 1
                        status = "error: " + str(exc)
                else:
                    source_folder = source_index[bad["mid"]]["folder"]

                rows.append({
                    "Folder": label,
                    "Status": status,
                    "MessageID": bad["mid"],
                    "OldFlags": bad["flags"],
                    "NewFlags": new_flags,
                    "SourceFolder": source_folder,
                    "Subject": bad["subject"],
                })
            if limit and restored + skipped_existing_good + missing_source + errors >= limit:
                break

        path = log_path()
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["Folder", "Status", "MessageID", "OldFlags", "NewFlags", "SourceFolder", "Subject"],
            )
            writer.writeheader()
            writer.writerows(rows)
        print(
            f"MAPI_PST_RESTORE_SUMMARY|Apply={apply}|FolderFilter={folder_filter}|Scanned={scanned}|"
            f"Bad={bad_count}|Restored={restored}|DeletedBad={deleted_bad}|ExistingGood={skipped_existing_good}|"
            f"MissingSource={missing_source}|Errors={errors}|Log={path}"
        )
    finally:
        session.Logoff(0, 0, 0)
        mapi.MAPIUninitialize()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--folder", default="All", choices=["All", "INBOX", "Sent_Messages"])
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    run(args.apply, args.folder, args.limit)
