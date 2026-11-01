"""Управление окном без стандартной рамки Windows: развернуть/свернуть/закрыть, размер, скругления.

Всё через Win32 и в физических пикселях, чтобы не путаться с масштабом экрана (125%, 150%…).
"""
import ctypes
import os
import sys

IS_WIN = os.name == "nt"
TITLE = "GamePicker"
_saved = {"rect": None}

if IS_WIN:
    from ctypes import wintypes as wt

    user32 = ctypes.windll.user32
    dwmapi = ctypes.windll.dwmapi

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

    SW_MINIMIZE, SW_RESTORE = 6, 9
    SWP_NOZORDER, SWP_NOACTIVATE, SWP_FRAMECHANGED = 0x0004, 0x0010, 0x0020
    MONITOR_DEFAULTTONEAREST = 2


def hwnd():
    if not IS_WIN:
        return 0
    return user32.FindWindowW(None, TITLE) or 0


def rect():
    h = hwnd()
    if not h:
        return None
    r = wt.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    return {"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top, "maximized": is_max()}


def _work_area(h):
    mon = user32.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST)
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(mon, ctypes.byref(mi))
    w = mi.rcWork
    return w.left, w.top, w.right - w.left, w.bottom - w.top


def is_max():
    h = hwnd()
    if not h or not _saved["rect"]:
        return False
    r = wt.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top) == _work_area(h)


def set_rect(x, y, w, h_):
    h = hwnd()
    if h:
        user32.SetWindowPos(h, 0, int(x), int(y), max(480, int(w)), max(420, int(h_)), SWP_NOZORDER | SWP_NOACTIVATE)


def toggle_max():
    """Развернуть на рабочую область (без перекрытия панели задач) или вернуть как было."""
    h = hwnd()
    if not h:
        return False
    if is_max() and _saved["rect"]:
        x, y, w, hh = _saved["rect"]
        _saved["rect"] = None
        set_rect(x, y, w, hh)
        return False
    r = wt.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    _saved["rect"] = (r.left, r.top, r.right - r.left, r.bottom - r.top)
    x, y, w, hh = _work_area(h)
    user32.SetWindowPos(h, 0, x, y, w, hh, SWP_NOZORDER)
    return True


def minimize():
    h = hwnd()
    if h:
        user32.ShowWindow(h, SW_MINIMIZE)


def style_window():
    """Скруглённые углы и тёмная тень Windows 11 для окна без рамки."""
    h = hwnd()
    if not h:
        return
    try:
        pref = ctypes.c_int(2)  # DWMWCP_ROUND
        dwmapi.DwmSetWindowAttribute(h, 33, ctypes.byref(pref), ctypes.sizeof(pref))
        dark = ctypes.c_int(1)
        dwmapi.DwmSetWindowAttribute(h, 20, ctypes.byref(dark), ctypes.sizeof(dark))
    except Exception:  # noqa: BLE001 — Windows 10 без этих атрибутов
        pass
