import argparse
import csv
import datetime as dt
import os
import re

from win32com.mapi import mapi, mapitags


PR_ENTRYID = mapitags.PR_ENTRYID
PR_DISPLAY_NAME_W = mapitags.PR_DISPLAY_NAME_W
PR_MESSAGE_FLAGS = mapitags.PR_MESSAGE_FLAGS
PR_SUBJECT_W = mapitags.PR_SUBJECT_W
PR_ATTACH_NUM = mapitags.PR_ATTACH_NUM
PR_INTERNET_MESSAGE_ID_A = mapitags.PROP_TAG(mapitags.PT_STRING8, 0x1035)
PR_INTERNET_MESSAGE_ID_W = mapitags.PROP_TAG(mapitags.PT_UNICODE, 0x1035)

MSGFLAG_UNSENT = 0x00000008


def row_dict(row):
    return {tag: value for tag, value in row}


def normalize_message_id(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("ascii", "ignore")
    return str(value).strip().lower().strip("<>").strip()


def console_text(value):
    text = str(value or "").replace("\r", " ").replace("\n", " ")
    return text.encode("cp949", "replace").decode("cp949")


def mail_root():
    return "D:\\" + chr(0xBA54) + chr(0xC77C)


def archive_root():
    return os.path.join(
        mail_root(),
        "".join(
            [
                chr(0xB124),
                chr(0xC774),
                chr(0xBC84),
                chr(0xBA54),
                chr(0xC77C),
                "_IMAP",
                chr(0xBC31),
                chr(0xC5C5),
            ]
        ),
        "daelimsm",
    )


def outlook_top_name():
    return "".join(
        [
            chr(0xCD5C),
            chr(0xC0C1),
            chr(0xC704),
            " Outlook ",
            chr(0xB370),
            chr(0xC774),
            chr(0xD130),
            " ",
            chr(0xD30C),
            chr(0xC77C),
        ]
    )


def pst_inbox_name():
    return "".join([chr(0xBC1B), chr(0xC740), " ", chr(0xBA54), chr(0xC77C), chr(0xD568)])


def pst_sent_name():
    return "".join([chr(0xBCF4), chr(0xB0B8), " ", chr(0xBA54), chr(0xC77C), chr(0xD568)])


def naver_inbox_name():
    return "".join([chr(0xBC1B), chr(0xC740), " ", chr(0xD3B8), chr(0xC9C0), chr(0xD568)])


def folder_config(label):
    configs = {
        "INBOX": {
            "archive": "INBOX",
            "pst": pst_inbox_name(),
            "source": naver_inbox_name(),
        },
        "Sent_Messages": {
            "archive": "Sent_Messages",
            "pst": pst_sent_name(),
            "source": "Sent Messages",
        },
    }
    return configs[label]


def read_archive_ids(folder_path):
    items = {}
    for base, _, files in os.walk(folder_path):
        for name in files:
            if not name.lower().endswith(".eml"):
                continue
            path = os.path.join(base, name)
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as handle:
                    text = handle.read(16384)
            except OSError:
                continue
            unfolded = re.sub(r"\r?\n[ \t]+", " ", text)
            match = re.search(r"(?im)^message-id:\s*(.+)$", unfolded)
            if not match:
                continue
            mid = normalize_message_id(match.group(1))
            if mid and mid not in items:
                items[mid] = path
    return items


def open_store_by_name(session, display_name, flags):
    table = session.GetMsgStoresTable(0)
    table.SetColumns((PR_ENTRYID, PR_DISPLAY_NAME_W), 0)
    while True:
        rows = table.QueryRows(50, 0)
        if not rows:
            break
        for row in rows:
            data = row_dict(row)
            if str(data.get(PR_DISPLAY_NAME_W) or "") == display_name:
                return session.OpenMsgStore(0, data[PR_ENTRYID], None, flags)
    raise RuntimeError("store not found: " + display_name)


def find_child(folder, display_name, flags=mapi.MAPI_BEST_ACCESS):
    table = folder.GetHierarchyTable(0)
    table.SetColumns((PR_ENTRYID, PR_DISPLAY_NAME_W), 0)
    while True:
        rows = table.QueryRows(50, 0)
        if not rows:
            break
        for row in rows:
            data = row_dict(row)
            if str(data.get(PR_DISPLAY_NAME_W) or "") == display_name:
                return folder.OpenEntry(data[PR_ENTRYID], None, flags)
    raise RuntimeError("folder not found: " + display_name)


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
        rows = table.QueryRows(500, 0)
        if not rows:
            break
        for row in rows:
            yield row


def collect_folder_info(folder):
    mids = {}
    no_id = 0
    unsent = 0
    scanned = 0
    for row in table_rows(folder):
        scanned += 1
        data = row_dict(row)
        flags = int(data.get(PR_MESSAGE_FLAGS) or 0)
        if flags & MSGFLAG_UNSENT:
            unsent += 1
        mid = normalize_message_id(data.get(PR_INTERNET_MESSAGE_ID_A) or data.get(PR_INTERNET_MESSAGE_ID_W))
        if not mid:
            no_id += 1
            continue
        mids[mid] = mids.get(mid, 0) + 1
    duplicate_sets = sum(1 for count in mids.values() if count > 1)
    duplicate_extra = sum(count - 1 for count in mids.values() if count > 1)
    return {
        "mids": mids,
        "no_id": no_id,
        "unsent": unsent,
        "duplicate_sets": duplicate_sets,
        "duplicate_extra": duplicate_extra,
        "scanned": scanned,
    }


def build_source_index(folder):
    index = {}
    for row in table_rows(folder):
        data = row_dict(row)
        flags = int(data.get(PR_MESSAGE_FLAGS) or 0)
        if flags & MSGFLAG_UNSENT:
            continue
        mid = normalize_message_id(data.get(PR_INTERNET_MESSAGE_ID_A) or data.get(PR_INTERNET_MESSAGE_ID_W))
        if mid and mid not in index:
            index[mid] = {
                "entry_id": data[PR_ENTRYID],
                "flags": flags,
                "subject": data.get(PR_SUBJECT_W) or "",
            }
    return index


def attachment_count(message):
    try:
        table = message.GetAttachmentTable(0)
        table.SetColumns((PR_ATTACH_NUM,), 0)
        count = 0
        while True:
            rows = table.QueryRows(50, 0)
            if not rows:
                break
            count += len(rows)
        return count
    except Exception:
        return -1


def verify_message(message, expected_mid):
    _, props = message.GetProps(
        (PR_MESSAGE_FLAGS, PR_SUBJECT_W, PR_INTERNET_MESSAGE_ID_A, PR_INTERNET_MESSAGE_ID_W, PR_ENTRYID),
        0,
    )
    data = row_dict(props)
    flags = int(data.get(PR_MESSAGE_FLAGS) or 0)
    mid = normalize_message_id(data.get(PR_INTERNET_MESSAGE_ID_A) or data.get(PR_INTERNET_MESSAGE_ID_W))
    return {
        "ok": mid == expected_mid and (flags & MSGFLAG_UNSENT) == 0,
        "entry_id": data.get(PR_ENTRYID),
        "flags": flags,
        "mid": mid,
        "subject": data.get(PR_SUBJECT_W) or "",
        "attachments": attachment_count(message),
    }


def log_path():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "logs")
    os.makedirs(path, exist_ok=True)
    return os.path.join(path, "mapi-safe-pst-import-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".csv")


def selected_labels(folder):
    if folder == "All":
        return ["INBOX", "Sent_Messages"]
    return [folder]


def run(apply, folder, limit_per_folder):
    mapi.MAPIInitialize(None)
    session = None
    rows = []
    imported = 0
    errors = 0
    try:
        session = mapi.MAPILogonEx(0, "", "", mapi.MAPI_EXTENDED | mapi.MAPI_USE_DEFAULT | mapi.MAPI_BEST_ACCESS)

        pst_store = open_store_by_name(
            session,
            "2026",
            mapi.MDB_WRITE | mapi.MAPI_MODIFY | mapi.MAPI_BEST_ACCESS,
        )
        pst_root = pst_store.OpenEntry(None, None, mapi.MAPI_BEST_ACCESS)
        pst_top = find_child(pst_root, outlook_top_name(), mapi.MAPI_BEST_ACCESS)

        naver_store = open_store_by_name(session, "daelimsm@naver.com", mapi.MAPI_BEST_ACCESS)
        naver_root = naver_store.OpenEntry(None, None, mapi.MAPI_BEST_ACCESS)
        naver_subtree = find_child(naver_root, "IPM_SUBTREE", mapi.MAPI_BEST_ACCESS)

        for label in selected_labels(folder):
            config = folder_config(label)
            pst_target = find_child(pst_top, config["pst"], mapi.MAPI_MODIFY | mapi.MAPI_BEST_ACCESS)
            naver_source = find_child(naver_subtree, config["source"], mapi.MAPI_BEST_ACCESS)
            archive = read_archive_ids(os.path.join(archive_root(), config["archive"]))
            before = collect_folder_info(pst_target)
            source = build_source_index(naver_source)
            missing = [mid for mid in sorted(archive.keys()) if mid not in before["mids"]]
            usable = [mid for mid in missing if mid in source]
            selected = usable[:limit_per_folder]

            print(
                f"FOLDER_BASELINE|Folder={label}|ArchiveUnique={len(archive)}"
                + f"|MissingFromPst={len(missing)}|SourceUsable={len(usable)}"
                + f"|Selected={len(selected)}|PstDuplicateSets={before['duplicate_sets']}"
                + f"|PstDuplicateExtra={before['duplicate_extra']}|PstNoId={before['no_id']}"
                + f"|PstUnsent={before['unsent']}"
            )

            for mid in selected:
                status = "dry-run"
                source_message = None
                new_message = None
                try:
                    source_message = naver_store.OpenEntry(source[mid]["entry_id"], None, mapi.MAPI_BEST_ACCESS)
                    source_attachments = attachment_count(source_message)
                    new_flags = ""
                    new_attachments = ""
                    target_count = ""
                    if apply:
                        new_message = pst_target.CreateMessage(None, 0)
                        source_message.CopyTo([], [], 0, None, mapi.IID_IMAPIProp, new_message, 0)
                        new_message.SaveChanges(mapi.KEEP_OPEN_READWRITE)
                        result = verify_message(new_message, mid)
                        new_flags = result["flags"]
                        new_attachments = result["attachments"]
                        if not result["ok"] or source_attachments != new_attachments:
                            if result["entry_id"]:
                                pst_target.DeleteMessages((result["entry_id"],), 0, None, 0)
                            raise RuntimeError(
                                "verify failed: "
                                + f"mid={result['mid']} flags={result['flags']} "
                                + f"attachments={result['attachments']}/{source_attachments}"
                            )
                        after_one = collect_folder_info(pst_target)
                        target_count = after_one["mids"].get(mid, 0)
                        if target_count != 1 or after_one["duplicate_extra"] != before["duplicate_extra"]:
                            pst_target.DeleteMessages((result["entry_id"],), 0, None, 0)
                            raise RuntimeError("duplicate check failed after import")
                        status = "imported"
                        imported += 1

                    rows.append(
                        {
                            "Folder": label,
                            "Status": status,
                            "MessageID": mid,
                            "Subject": source[mid]["subject"],
                            "SourceFlags": source[mid]["flags"],
                            "SourceAttachments": source_attachments,
                            "NewFlags": new_flags,
                            "NewAttachments": new_attachments,
                            "TargetPstCount": target_count,
                            "Eml": archive[mid],
                        }
                    )
                    print(
                        f"ITEM|Folder={label}|Status={status}|MessageID={mid}"
                        + f"|SourceAttachments={source_attachments}|NewAttachments={new_attachments}"
                        + f"|TargetPstCount={target_count}|Subject={console_text(source[mid]['subject'][:120])}"
                    )
                except Exception as exc:
                    errors += 1
                    rows.append(
                        {
                            "Folder": label,
                            "Status": "error: " + str(exc),
                            "MessageID": mid,
                            "Subject": source.get(mid, {}).get("subject", ""),
                            "SourceFlags": source.get(mid, {}).get("flags", ""),
                            "SourceAttachments": "",
                            "NewFlags": "",
                            "NewAttachments": "",
                            "TargetPstCount": "",
                            "Eml": archive.get(mid, ""),
                        }
                    )
                    print(f"ITEM_ERROR|Folder={label}|MessageID={mid}|Error={console_text(exc)}")
                    raise
                finally:
                    source_message = None
                    new_message = None

            after = collect_folder_info(pst_target)
            after_missing = len([mid for mid in archive if mid not in after["mids"]])
            print(
                f"FOLDER_RESULT|Folder={label}|MissingAfter={after_missing}"
                + f"|PstDuplicateSets={after['duplicate_sets']}|PstDuplicateExtra={after['duplicate_extra']}"
                + f"|PstNoId={after['no_id']}|PstUnsent={after['unsent']}"
            )

        path = log_path()
        with open(path, "w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "Folder",
                    "Status",
                    "MessageID",
                    "Subject",
                    "SourceFlags",
                    "SourceAttachments",
                    "NewFlags",
                    "NewAttachments",
                    "TargetPstCount",
                    "Eml",
                ],
            )
            writer.writeheader()
            writer.writerows(rows)
        print(f"SAFE_IMPORT_SUMMARY|Apply={apply}|Imported={imported}|Errors={errors}|Log={path}")
    finally:
        if session is not None:
            session.Logoff(0, 0, 0)
        mapi.MAPIUninitialize()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--folder", default="All", choices=["All", "INBOX", "Sent_Messages"])
    parser.add_argument("--limit-per-folder", type=int, default=5)
    args = parser.parse_args()
    if args.limit_per_folder < 1:
        raise RuntimeError("--limit-per-folder must be at least 1")
    run(args.apply, args.folder, args.limit_per_folder)


if __name__ == "__main__":
    main()
