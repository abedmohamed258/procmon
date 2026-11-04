#!/usr/bin/env python3
"""Extract translatable strings from the GJS sources into po/procmon.pot.

GNU xgettext does not parse JavaScript, and every UI string here goes through
the local `_()` / `_n()` wrappers from ui/constants.js, so this small
extractor matches exactly those call shapes:

    _('single string')
    _n('singular', 'plural', count)

It understands single/double quotes and the usual backslash escapes. Output
is a gettext POT file; merge it into po/ar.po with msgmerge:

    python3 scripts/extract-strings.py > po/procmon.pot
    msgmerge --update po/ar.po po/procmon.pot
    msgfmt -c po/ar.po -o locale/ar/LC_MESSAGES/procmon@abed.dev.mo

Run this after adding or changing any user-visible string.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [
    ROOT / 'extension.js',
    ROOT / 'prefs.js',
    *sorted((ROOT / 'ui').glob('*.js')),
]

# _('...') / _("...") — but not _n( (handled below) and not Gettext.domain.
SINGLE_RE = re.compile(
    r"(?<![\w.])(?:_)\(\s*(['\"])((?:\\.|(?!\1).)*)\1\s*\)")
# _n('singular', 'plural', n)
PLURAL_RE = re.compile(
    r"(?<![\w.])_n\(\s*(['\"])((?:\\.|(?!\1).)*)\1\s*,\s*"
    r"(['\"])((?:\\.|(?!\3).)*)\3\s*,")


def unescape(raw: str) -> str:
    out = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == '\\' and i + 1 < len(raw):
            nxt = raw[i + 1]
            simple = {'n': '\n', 't': '\t', 'r': '\r', '\\': '\\',
                      "'": "'", '"': '"'}
            if nxt in simple:
                out.append(simple[nxt])
                i += 2
                continue
            if nxt == 'u' and i + 5 < len(raw) + 1:
                try:
                    out.append(chr(int(raw[i + 2:i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    pass
            out.append(nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def po_escape(text: str) -> str:
    return (text.replace('\\', '\\\\').replace('"', '\\"')
                .replace('\n', '\\n').replace('\t', '\\t'))


def collect():
    singles = {}   # msgid -> first source ref in line order
    plurals = {}   # singular -> (plural, ref)
    for path in SOURCES:
        text = path.read_text(encoding='utf-8')
        rel = path.relative_to(ROOT).as_posix()
        for match in PLURAL_RE.finditer(text):
            singular = unescape(match.group(2))
            plural = unescape(match.group(4))
            line = text.count('\n', 0, match.start()) + 1
            plurals.setdefault(singular, (plural, f'{rel}:{line}'))
        # blank out _n(...) calls so their singular isn't seen as a single
        masked = PLURAL_RE.sub(' ', text)
        for match in SINGLE_RE.finditer(masked):
            msgid = unescape(match.group(2))
            line = masked.count('\n', 0, match.start()) + 1
            if msgid not in singles and msgid not in plurals:
                singles[msgid] = f'{rel}:{line}'
    return singles, plurals


def main():
    singles, plurals = collect()
    entries = []
    for singular in sorted(plurals):
        plural, ref = plurals[singular]
        entries.append(
            f'#: {ref}\nmsgid "{po_escape(singular)}"\n'
            f'msgid_plural "{po_escape(plural)}"\nmsgstr[0] ""\nmsgstr[1] ""')
    for msgid in sorted(singles):
        entries.append(
            f'#: {singles[msgid]}\nmsgid "{po_escape(msgid)}"\nmsgstr ""')
    header = (
        '# ProcMon translatable strings.\n'
        '#, fuzzy\nmsgid ""\nmsgstr ""\n'
        '"Project-Id-Version: procmon 2.7.0\\n"\n'
        '"Report-Msgid-Bugs-To: https://github.com/abedmohamed258/procmon/issues\\n"\n'
        '"POT-Creation-Date: 2026-11-04 00:00+0200\\n"\n'
        '"PO-Revision-Date: YEAR-MO-DA HO:MI+ZONE\\n"\n'
        '"Last-Translator: FULL NAME <EMAIL@ADDRESS>\\n"\n'
        '"Language-Team: \\n"\n'
        '"MIME-Version: 1.0\\n"\n'
        '"Content-Type: text/plain; charset=UTF-8\\n"\n'
        '"Content-Transfer-Encoding: 8bit\\n"\n\n'
    )
    sys.stdout.write(header + '\n\n'.join(entries) + '\n')
    print(f'# {len(singles)} single + {len(plurals)} plural strings',
          file=sys.stderr)


if __name__ == '__main__':
    main()
