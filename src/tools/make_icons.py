"""Generates the toolbar icons (grey = idle, green = counting). No dependencies."""
import math, os, struct, zlib

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def render(size, rgb):
    ss = 4
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            circ = hands = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + .5) / ss) / size
                    v = (y + (sy + .5) / ss) / size
                    r = math.hypot(u - .5, v - .5)
                    if r <= .47:
                        circ += 1
                        ring = abs(r - .33) < .035
                        h = (seg_dist(u, v, .5, .5, .5, .26) < .05 or
                             seg_dist(u, v, .5, .5, .66, .5) < .05)
                        if ring or h:
                            hands += 1
            n = ss * ss
            a = circ / n
            w = hands / circ if circ else 0
            col = [round(c + (255 - c) * w) for c in rgb]
            row += bytes(col + [round(255 * a)])
        rows.append(bytes(row))
    return rows

def write_png(path, size, rgb):
    raw = b''.join(render(size, rgb))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

out = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(out, exist_ok=True)
for name, rgb in (('idle', (92, 98, 110)), ('active', (22, 163, 74))):
    for s in (16, 32, 48, 128):
        write_png(os.path.join(out, f'{name}-{s}.png'), s, rgb)
