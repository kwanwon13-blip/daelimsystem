import csv
import datetime as dt
import os
import sys

import pythoncom
import win32com.client
from win32com.mapi import mapi, mapitags


PR_ENTRYID = mapitags.PR_ENTRYID
PR_DISPLAY_NAME_W = mapitags.PR_DISPLAY_NAME_W
PR_DEFAULT_STORE = mapitags.PR_DEFAULT_STORE
PR_STORE_ENTRYID = mapitags.PR_STORE_ENTRYID
PR_MESSAGE_FLAGS = mapitags.PR_MESSAGE_FLAGS

MSGFLAG_READ = 0x00000001
MSGFLAG_UNSENT = 0x00000008
MSGFLAG_FROMME = 0x00000020


def mapi_hex(entry_id):
    if isinstance(entry_id, bytes):
        return entry_id.hex().upper()
    return bytes(entry_id).hex().upper()


def outlook_mail_root():
    return "D:\\" + chr(0xBA54) + chr(0xC77C)


def pst_path():
    return os.path.join(outlook_mail_root(), "2026.pst")


def get_outlook_targets():
    outlook = win32com.client.Dispatch("Outlook.Application")
    ns = outlook.GetNamespace("MAPI")
    pst = pst_path()
    store = None
    for candidate in ns.Stores:
        if candidate.FilePath == pst:
            store = candidate
            break
    if store is None:
        raise RuntimeError(f"PST store not found in Outlook profile: {pst}")

    root = store.GetRootFolder()
    inbox_name = "".join([chr(0xBC1B), chr(0xC740), " ", chr(0xBA54), chr(0xC77C), chr(0xD568)])
    sent_name = "".join([chr(0xBCF4), chr(0xB0B8), " ", chr(0xBA54), chr(0xC77C), chr(0xD568)])
    return {
        "INBOX": {"folder": root.Folders.Item(inbox_name), "add_from_me": False},
        "Sent_Messages": {"folder": root.Folders.Item(sent_name), "add_from_me": True},
    }


def collect_outlook_entryids(folder):
    ids = []
    count = int(folder.Items.Count)
    for index in range(1, count + 1):
        try:
            item = folder.Items.Item(index)
            if item is not None:
                ids.append(str(item.EntryID))
        except Exception:
            pass
    return ids


def open_mapi_session():
    mapi.MAPIInitialize(None)
    flags = mapi.MAPI_EXTENDED | mapi.MAPI_USE_DEFAULT | mapi.MAPI_BEST_ACCESS
    return mapi.MAPILogonEx(0, "", "", flags)


def get_store(session, outlook_store_id_hex):
    table = session.GetMsgStoresTable(0)
    table.SetColumns((PR_ENTRYID, PR_DISPLAY_NAME_W, PR_DEFAULT_STORE, PR_STORE_ENTRYID), 0)
    while True:
        rows = table.QueryRows(20, 0)
        if not rows:
            break
        for row in rows:
            props = {tag: value for tag, value in row}
            entry_id = props.get(PR_ENTRYID)
            if entry_id and mapi_hex(entry_id) == outlook_store_id_hex:
                return session.OpenMsgStore(0, entry_id, None, mapi.MDB_WRITE | mapi.MAPI_BEST_ACCESS)
    raise RuntimeError("MAPI store not found from Outlook StoreID")


def get_prop(obj, tag):
    hr, props = obj.GetProps((tag,), 0)
    if hr != 0 or not props:
        raise RuntimeError(f"GetProps failed for {hex(tag)} hr={hr}")
    prop_tag, value = props[0]
    if mapitags.PROP_TYPE(prop_tag) == mapitags.PT_ERROR:
        raise RuntimeError(f"Property returned PT_ERROR for {hex(tag)} value={value}")
    return value


def set_flags(message, new_flags):
    message.SetProps(((PR_MESSAGE_FLAGS, int(new_flags)),))
    message.SaveChanges(mapi.KEEP_OPEN_READWRITE)


def repaired_flags(old_flags, add_from_me):
    flags = int(old_flags) & ~MSGFLAG_UNSENT
    flags |= MSGFLAG_READ
    if add_from_me:
        flags |= MSGFLAG_FROMME
    return flags


def run(apply=False, folder_filter="All", limit=0):
    targets = get_outlook_targets()
    selected = []
    for label, data in targets.items():
        if folder_filter == "All" or folder_filter == label:
            selected.append((label, data))

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f"mapi-pst-flag-repair-{timestamp}.csv")

    session = open_mapi_session()
    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
        ns = outlook.GetNamespace("MAPI")
        pst = pst_path()
        outlook_store = None
        for candidate in ns.Stores:
            if candidate.FilePath == pst:
                outlook_store = candidate
                break
        if outlook_store is None:
            raise RuntimeError(f"Outlook store not found: {pst}")
        store_id_hex = str(outlook_store.StoreID).upper()
        store = get_store(session, store_id_hex)

        rows = []
        scanned = candidates = updated = errors = 0
        for label, data in selected:
            ids = collect_outlook_entryids(data["folder"])
            for entry_id_hex in ids:
                if limit and candidates >= limit:
                    break
                try:
                    entry_bytes = bytes.fromhex(entry_id_hex)
                    message = store.OpenEntry(entry_bytes, None, mapi.MAPI_MODIFY | mapi.MAPI_BEST_ACCESS)
                    old_flags = int(get_prop(message, PR_MESSAGE_FLAGS))
                    scanned += 1
                    if (old_flags & MSGFLAG_UNSENT) == 0:
                        continue
                    candidates += 1
                    new_flags = repaired_flags(old_flags, data["add_from_me"])
                    verify_flags = ""
                    status = "dry-run"
                    if apply:
                        set_flags(message, new_flags)
                        reopened = store.OpenEntry(entry_bytes, None, mapi.MAPI_MODIFY | mapi.MAPI_BEST_ACCESS)
                        verify_flags = int(get_prop(reopened, PR_MESSAGE_FLAGS))
                        verify_ok = (verify_flags & MSGFLAG_UNSENT) == 0 and (verify_flags & MSGFLAG_READ) != 0
                        if data["add_from_me"]:
                            verify_ok = verify_ok and (verify_flags & MSGFLAG_FROMME) != 0
                        if verify_ok:
                            updated += 1
                            status = "updated"
                        else:
                            errors += 1
                            status = "verify-failed"
                    rows.append({
                        "Folder": label,
                        "EntryID": entry_id_hex,
                        "OldFlags": old_flags,
                        "NewFlags": new_flags,
                        "VerifyFlags": verify_flags,
                        "Status": status,
                    })
                except Exception as exc:
                    errors += 1
                    rows.append({
                        "Folder": label,
                        "EntryID": entry_id_hex,
                        "OldFlags": "",
                        "NewFlags": "",
                        "VerifyFlags": "",
                        "Status": "error: " + str(exc),
                    })
            if limit and candidates >= limit:
                break

        with open(log_path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=["Folder", "EntryID", "OldFlags", "NewFlags", "VerifyFlags", "Status"])
            writer.writeheader()
            writer.writerows(rows)
        print(
            f"MAPI_FLAG_REPAIR_SUMMARY|Apply={apply}|FolderFilter={folder_filter}|"
            f"Scanned={scanned}|Candidates={candidates}|Updated={updated}|Errors={errors}|Log={log_path}"
        )
    finally:
        try:
            session.Logoff(0, 0, 0)
        finally:
            mapi.MAPIUninitialize()


if __name__ == "__main__":
    apply = "--apply" in sys.argv
    folder = "All"
    limit = 0
    for arg in sys.argv[1:]:
        if arg.startswith("--folder="):
            folder = arg.split("=", 1)[1]
        elif arg.startswith("--limit="):
            limit = int(arg.split("=", 1)[1])
    run(apply=apply, folder_filter=folder, limit=limit)
