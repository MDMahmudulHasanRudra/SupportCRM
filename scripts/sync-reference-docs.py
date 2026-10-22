"""Maintain source-derived route/schema references; no services or credentials are accessed."""
from pathlib import Path
import argparse
import re
import sys

ROOT = Path(__file__).resolve().parent.parent


def link(path):
    return f"[{path.stem}]({path.relative_to(ROOT / 'docs')})" if path.is_relative_to(ROOT / 'docs') else f"[{path.stem}](../{path.relative_to(ROOT).as_posix()})"


def api_inventory():
    rows = []
    for path in sorted((ROOT / 'apps/api/src/modules').rglob('*.controller.ts')):
        source = path.read_text(encoding='utf-8')
        controller = re.search(r"@Controller\(['\"]([^'\"]*)['\"]\)", source)
        if not controller:
            continue
        routes = list(re.finditer(r"@(Get|Post|Put|Patch|Delete)\((?:['\"]([^'\"]*)['\"])?\)", source))
        for i, route in enumerate(routes):
            block = source[route.end():routes[i + 1].start() if i + 1 < len(routes) else len(source)]
            method = re.search(r'^  (?:async\s+)?(\w+)\s*\(', block, re.M)
            if not method:
                raise ValueError(f'Cannot resolve route handler: {path}:{route.group(0)}')
            decorators = block[:method.start()]
            permissions = re.search(r'@RequirePermissions\(([^)]*)\)', decorators)
            required = ', '.join(re.findall(r"['\"]([^'\"]+)['\"]", permissions[1])) if permissions else 'Session (see controller/global guard)'
            if '@Public()' in source[max(0, route.start() - 80):route.start()]:
                required = 'Public; signature/session rules in source'
            body = re.search(r'@Body\(\)\s+\w+:\s+(\w+)', block[:block.find('\n  }') if '\n  }' in block else len(block)])
            url = '/api/v1/' + '/'.join(s.strip('/') for s in [controller[1], route[2] or ''] if s)
            rows.append(f"| {route[1].upper()} | `{url}` | {required} | `{body[1] if body else '—'}` | {link(path)} · `{method[1]}` |")
    return f"\nSource-derived inventory: **{len(rows)} routes**. Permission labels are declarations; global/controller guards and service checks remain authoritative. DTO/source links define exact validation and responses.\n\n| Method | Route | Required permission | Body DTO | Source / handler |\n|---|---|---|---|---|\n" + '\n'.join(rows) + '\n'


def schema_inventory():
    blocks = []
    for path in sorted((ROOT / 'apps/api/src/modules').rglob('*.entity.ts')):
        source = path.read_text(encoding='utf-8')
        entities = list(re.finditer(r"@Entity\(['\"]([^'\"]+)['\"]\)", source))
        for i, entity in enumerate(entities):
            block = source[entity.end():entities[i + 1].start() if i + 1 < len(entities) else len(source)]
            fields = re.findall(r'^  (\w+)!:\s*([^;]+);', block, re.M)
            summary = ', '.join('`' + name + ': ' + kind.replace('|', '\\|') + '`' for name, kind in fields)
            blocks.append(f"| `{entity[1]}` | {summary} | {link(path)} |")
    migrations = [ROOT / 'apps/api/src/database/migrations' / name for name in ['1788400000000-WorkspaceOperations.ts', '1788400001000-ShiftLifecycle.ts']]
    extra = '\n\n### Workspace SQL tables\n\nThese are migration-defined and queried transactionally through the existing DataSource; relation/index/check details are in the migration.\n\n| Table | DDL fields | Source |\n|---|---|---|\n'
    for migration in migrations:
        ddl = migration.read_text(encoding='utf-8')
        tables = re.findall(r'CREATE TABLE (\w+)\s*\(([\s\S]*?)\n      \);', ddl)
        for name, body in tables:
            fields = re.findall(r'(?:^|,)\s*(?:"(\w+)"|(\w+))\s+(uuid|varchar\(\d+\)|bigint|boolean|date|timestamptz|jsonb|text)', body)
            extra += f"| `{name}` | " + ', '.join(f'`{a or b}: {kind}`' for a, b, kind in fields) + f' | {link(migration)} |\n'
    return f"\n### TypeORM entities\n\nSource-derived inventory: **{len(blocks)} entity tables**. Relation properties are included; inspect decorators/migrations for nullability, defaults, foreign keys and indexes.\n\n| Table | Declared properties | Source |\n|---|---|---|\n" + '\n'.join(blocks) + extra


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    changed = []
    for name, marker, content in [('08-API-CONTRACTS.md', 'API', api_inventory()), ('07-DATABASE-SCHEMA.md', 'SCHEMA', schema_inventory())]:
        path = ROOT / 'docs' / name
        source = path.read_text(encoding='utf-8')
        pattern = rf'(<!-- BEGIN GENERATED {marker} -->)[\s\S]*?(<!-- END GENERATED {marker} -->)'
        if not re.search(pattern, source):
            raise ValueError(f'Missing generated section in {name}')
        updated = re.sub(pattern, lambda m: m[1] + content + m[2], source)
        if updated != source:
            changed.append(name)
            if not args.check:
                path.write_text(updated, encoding='utf-8')
    if args.check and changed:
        print('Reference documents are stale: ' + ', '.join(changed) + '. Run python scripts/sync-reference-docs.py.')
        return 1
    print('Reference documents verified.' if args.check else 'Reference documents synchronized.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
