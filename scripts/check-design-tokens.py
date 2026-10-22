"""Check key text/background pairs against 4.5:1. Not a rendered-page accessibility audit."""
from pathlib import Path
import re
import sys

source = (Path(__file__).resolve().parent.parent / 'apps/web/src/theme.css').read_text(encoding='utf-8')
dark = dict(re.findall(r'(--[\w-]+):\s*(#[0-9a-f]{6})', source[:source.index('@media')]))
light = dark | dict(re.findall(r'(--[\w-]+):\s*(#[0-9a-f]{6})', source[source.index(":root[data-theme='light']"):]))


def luminance(color):
    rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in rgb]
    return sum(v * weight for v, weight in zip(linear, [.2126, .7152, .0722]))


pairs = [('text', 'surface'), ('text', 'bg'), ('text-muted', 'surface'), ('text-muted', 'bg'),
         ('text-faint', 'surface'), ('text-faint', 'bg'), ('accent', 'accent-soft'),
         ('accent-text', 'accent-fill'), ('sidebar-text', 'sidebar-bg'), ('hero-muted', 'hero-bg')]
failures = []
for mode, tokens in [('light', light), ('dark', dark)]:
    for foreground, background in pairs:
        lower, upper = sorted([luminance(tokens['--' + foreground]), luminance(tokens['--' + background])])
        ratio = (upper + .05) / (lower + .05)
        if ratio < 4.5:
            failures.append(f'{mode}: {foreground}/{background} = {ratio:.2f}:1')
if failures:
    print('Contrast checks failed:\n' + '\n'.join(failures))
    sys.exit(1)
print(f'{len(pairs) * 2} core theme contrast pairs passed (minimum 4.5:1). Rendered-page review remains separate.')
