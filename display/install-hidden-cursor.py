"""Install a transparent cursor theme for the dedicated kiosk session."""

from pathlib import Path
import struct


def transparent_cursor() -> bytes:
    size = 24
    image_type = 0xFFFD0002
    header = struct.pack('<4I', 0x72756358, 16, 0x10000, 1)
    table = struct.pack('<3I', image_type, size, 28)
    image = struct.pack('<9I', 36, image_type, size, 1, size, size, 0, 0, 0)
    return header + table + image + bytes(size * size * 4)


def install() -> None:
    theme = Path('/usr/local/share/ups-kiosk/icons/default')
    cursors = theme / 'cursors'
    cursors.mkdir(parents=True, exist_ok=True)
    (theme / 'index.theme').write_text('[Icon Theme]\nName=Invisible UPS kiosk cursor\n', encoding='utf-8')
    (cursors / 'invisible').write_bytes(transparent_cursor())
    # Include the platform's named cursors and legacy aliases to avoid fallback arrows.
    names = {'default', 'left_ptr', 'arrow', 'pointer', 'hand2', 'text', 'xterm', 'wait', 'watch'}
    names.update(path.name for path in Path('/usr/share/icons/Adwaita/cursors').iterdir())
    for name in sorted(names - {'invisible'}):
        alias = cursors / name
        if not alias.is_symlink() or alias.readlink() != Path('invisible'):
            alias.symlink_to('invisible')
    print(f'Installed transparent kiosk cursor with {len(names)} aliases.')


if __name__ == '__main__':
    install()
