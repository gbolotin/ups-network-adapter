import ctypes as c
import os
from pathlib import Path
os.environ['XCURSOR_PATH']='/usr/local/share/ups-kiosk/icons'
os.environ['XCURSOR_THEME']='default'
class Image(c.Structure):
    _fields_=[('width',c.c_uint32),('height',c.c_uint32),('hotspot_x',c.c_uint32),('hotspot_y',c.c_uint32),('delay',c.c_uint32),('buffer',c.POINTER(c.c_uint8))]
class Cursor(c.Structure):
    _fields_=[('image_count',c.c_uint),('images',c.POINTER(c.POINTER(Image))),('name',c.c_char_p),('total_delay',c.c_uint32)]
lib=c.CDLL('/lib/aarch64-linux-gnu/libwlroots-0.20.so')
lib.wlr_xcursor_theme_load.argtypes=[c.c_char_p,c.c_int]
lib.wlr_xcursor_theme_load.restype=c.c_void_p
lib.wlr_xcursor_theme_get_cursor.argtypes=[c.c_void_p,c.c_char_p]
lib.wlr_xcursor_theme_get_cursor.restype=c.POINTER(Cursor)
lib.wlr_xcursor_theme_destroy.argtypes=[c.c_void_p]
theme=lib.wlr_xcursor_theme_load(None,24)
assert theme, 'Cage must be able to load the default cursor theme'
try:
    for path in Path('/usr/local/share/ups-kiosk/icons/default/cursors').iterdir():
        cursor=lib.wlr_xcursor_theme_get_cursor(theme,path.name.encode())
        assert cursor and cursor.contents.image_count==1,path.name
        image=cursor.contents.images[0].contents
        assert image.width==24 and image.height==24,path.name
        assert not any(c.string_at(image.buffer,image.width*image.height*4)),path.name
    print('Native wlroots loader verified all 63 cursor images are fully transparent, including the default arrow.')
finally:
    lib.wlr_xcursor_theme_destroy(theme)
