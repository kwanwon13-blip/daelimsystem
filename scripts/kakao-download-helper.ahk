#NoEnv
#SingleInstance Force
SendMode Input
SetWorkingDir %A_ScriptDir%
SetTitleMatchMode, 2

IniFile := A_ScriptDir . "\kakao-download-helper.ini"
DefaultInbox := "C:\CompanyAssets\KakaoInbox"

IniRead, InboxDir, %IniFile%, paths, inbox, %DefaultInbox%
IniRead, ClickX, %IniFile%, click, x,
IniRead, ClickY, %IniFile%, click, y,

FileCreateDir, %InboxDir%

F1::
MsgBox, 64, Kakao Download Helper,
(
F2  Save current mouse position as the download/save button.
F3  Click saved position and wait until the inbox folder is quiet.
F4  Only wait until the inbox folder is quiet.
F8  Open inbox folder.
F9  Pause or resume this helper.
F12 Exit.

Inbox:
%InboxDir%
)
Return

F2::
MouseGetPos, ClickX, ClickY
IniWrite, %ClickX%, %IniFile%, click, x
IniWrite, %ClickY%, %IniFile%, click, y
TrayTip, Kakao Helper, Saved click position: %ClickX%`, %ClickY%, 2, 1
Return

F3::
if (ClickX = "" || ClickY = "") {
    MsgBox, 48, Kakao Helper, Press F2 on the download/save button first.
    Return
}
before := CountImages(InboxDir)
Click, %ClickX%, %ClickY%
ok := WaitForFolderQuiet(InboxDir, before, 600, 5)
if (ok) {
    after := CountImages(InboxDir)
    added := after - before
    TrayTip, Kakao Helper, Download looks complete. Added: %added%, 4, 1
    SoundBeep, 880, 180
} else {
    TrayTip, Kakao Helper, Timeout. Check Kakao or browser manually., 5, 2
    SoundBeep, 440, 300
}
Return

F4::
before := CountImages(InboxDir)
ok := WaitForFolderQuiet(InboxDir, before, 600, 5)
if (ok) {
    TrayTip, Kakao Helper, Folder is quiet., 3, 1
    SoundBeep, 880, 180
} else {
    TrayTip, Kakao Helper, Timeout while waiting., 5, 2
    SoundBeep, 440, 300
}
Return

F8::
Run, %InboxDir%
Return

F9::Pause
F12::ExitApp

CountImages(dir) {
    count := 0
    Loop, Files, %dir%\*.*, R
    {
        if (IsImageName(A_LoopFileName))
            count += 1
    }
    return count
}

TotalImageSize(dir) {
    total := 0
    Loop, Files, %dir%\*.*, R
    {
        if (IsImageName(A_LoopFileName))
            total += A_LoopFileSize
    }
    return total
}

IsImageName(name) {
    SplitPath, name,,, ext
    StringLower, ext, ext
    return InStr("|jpg|jpeg|png|webp|gif|bmp|tif|tiff|heic|heif|", "|" . ext . "|")
}

WaitForFolderQuiet(dir, beforeCount, timeoutSec, quietSec) {
    startTick := A_TickCount
    lastCount := CountImages(dir)
    lastSize := TotalImageSize(dir)
    quietStart := A_TickCount

    Loop {
        Sleep, 1000
        nowCount := CountImages(dir)
        nowSize := TotalImageSize(dir)

        if (nowCount != lastCount || nowSize != lastSize) {
            lastCount := nowCount
            lastSize := nowSize
            quietStart := A_TickCount
        }

        if (nowCount > beforeCount && A_TickCount - quietStart >= quietSec * 1000)
            return true

        if (A_TickCount - startTick >= timeoutSec * 1000)
            return false
    }
}
