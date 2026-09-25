"""Cancellable pipe reading without a blocked buffered stdin thread at exit."""
import os


class FrameError(ValueError):
    pass


def chunks(stream, stop, size=16384):
    fd = stream.fileno()
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        peek = kernel.PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                         wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD]
        peek.restype = wintypes.BOOL
        kind = kernel.GetFileType
        kind.argtypes = [wintypes.HANDLE]
        kind.restype = wintypes.DWORD
        handle = msvcrt.get_osfhandle(fd)
        pipe = kind(handle) == 3  # FILE_TYPE_PIPE
        msvcrt.setmode(fd, os.O_BINARY)
        while not stop.is_set():
            if pipe:
                available = wintypes.DWORD()
                if not peek(handle, None, 0, None, ctypes.byref(available), None):
                    error = ctypes.get_last_error()
                    if error in (109, 232, 233):  # closed/broken pipe
                        return
                    raise ctypes.WinError(error)
                if not available.value:
                    stop.wait(.01)
                    continue
                count = min(size, available.value)
            else:
                count = size  # redirected regular file; console handled separately
            chunk = os.read(fd, count)
            if not chunk:
                return
            yield chunk
    else:
        import select
        while not stop.is_set():
            if not select.select([fd], [], [], .05)[0]:
                continue
            chunk = os.read(fd, size)
            if not chunk:
                return
            yield chunk


def lines(stream, stop, limit):
    buffer = bytearray()
    for chunk in chunks(stream, stop):
        buffer.extend(chunk)
        while b"\n" in buffer:
            split = buffer.index(b"\n") + 1
            if split > limit:
                raise FrameError("frame exceeds 1 MiB")
            yield bytes(buffer[:split])
            del buffer[:split]
        if len(buffer) > limit:
            raise FrameError("frame exceeds 1 MiB")
    if buffer and not stop.is_set():
        raise FrameError("frame must end with newline")


def console_lines(stop, limit):
    """Windows interactive control: simple line input, not a terminal editor."""
    import msvcrt
    import sys
    text = ""
    while not stop.is_set():
        if not msvcrt.kbhit():
            stop.wait(.02)
            continue
        char = msvcrt.getwch()
        if char in ("\x00", "\xe0"):
            msvcrt.getwch()  # function/arrow key prefix
        elif char in ("\r", "\n"):
            sys.stderr.write("\n")
            sys.stderr.flush()
            yield (text + "\n").encode("utf-8")
            text = ""
        elif char == "\x08":
            if text:
                text = text[:-1]
                sys.stderr.write("\b \b")
                sys.stderr.flush()
        elif char == "\x1a":
            return
        elif char == "\x03":
            yield b'{"op":"shutdown","reason":"keyboard_interrupt"}\n'
            return
        else:
            text += char
            if len(text.encode("utf-8", errors="surrogatepass")) > limit:
                raise FrameError("frame exceeds 1 MiB")
            sys.stderr.write(char)
            sys.stderr.flush()
