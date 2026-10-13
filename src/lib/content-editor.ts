// src/lib/content-editor.ts
// Helper untuk parse/edit markdown frontmatter yukio-data.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitContent(content: string): {
  frontmatter: string;
  body: string;
} {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: content };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

export function joinContent(frontmatter: string, body: string): string {
  const fm = frontmatter.replace(/^\n+|\n+$/g, '');
  const b = body.replace(/^\n+|\n+$/g, '');
  return `---\n${fm}\n---\n\n${b}\n`;
}

function setFrontmatterField(
  frontmatter: string,
  field: string,
  value: string
): string {
  const lines = frontmatter.split('\n');

  if (field.includes('.')) {
    const [parent, child] = field.split('.');
    if (!parent || !child) return frontmatter;

    const parentRe = new RegExp(`^${escapeRegex(parent)}:\\s*$`);
    let parentIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (parentRe.test(lines[i] ?? '')) {
        parentIdx = i;
        break;
      }
    }

    if (parentIdx === -1) {
      lines.push(`${parent}:`);
      lines.push(`  ${child}: ${value}`);
      return lines.join('\n');
    }

    for (let i = parentIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!/^\s+/.test(line)) break;
      const childRe = new RegExp(`^(\\s+)${escapeRegex(child)}:\\s*.*$`);
      if (childRe.test(line)) {
        const m = line.match(childRe);
        lines[i] = `${m?.[1] ?? '  '}${child}: ${value}`;
        return lines.join('\n');
      }
    }

    let insertIdx = parentIdx + 1;
    while (insertIdx < lines.length && /^\s+/.test(lines[insertIdx] ?? '')) {
      insertIdx++;
    }
    lines.splice(insertIdx, 0, `  ${child}: ${value}`);
    return lines.join('\n');
  }

  const re = new RegExp(`^${escapeRegex(field)}:\\s*.*$`, 'm');
  if (re.test(frontmatter)) {
    return frontmatter.replace(re, `${field}: ${value}`);
  }
  return frontmatter + '\n' + `${field}: ${value}`;
}

export function getFrontmatterField(
  frontmatter: string,
  field: string
): string | null {
  if (field === 'body') return null;

  if (field.includes('.')) {
    const [parent, child] = field.split('.');
    if (!parent || !child) return null;
    const lines = frontmatter.split('\n');
    let inParent = false;
    for (const line of lines) {
      if (new RegExp(`^${escapeRegex(parent)}:\\s*$`).test(line)) {
        inParent = true;
        continue;
      }
      if (inParent) {
        if (!/^\s+/.test(line)) break;
        const m = line.match(new RegExp(`^\\s+${escapeRegex(child)}:\\s*(.*)$`));
        if (m) return m[1] ?? '';
      }
    }
    return null;
  }

  const re = new RegExp(`^${escapeRegex(field)}:\\s*(.*)$`, 'm');
  const m = frontmatter.match(re);
  return m ? (m[1] ?? '') : null;
}

export function yamlSafeString(v: string): string {
  const t = v.replace(/\n/g, ' ').trim();
  if (t === '') return '""';
  if (/[:#&*!|>'"%@`{}\[\],]/.test(t) || /^\d/.test(t)) {
    return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return t;
}

export function applyEdits(
  content: string,
  edits: Record<string, string>
): string {
  const { frontmatter, body } = splitContent(content);
  let fm = frontmatter;
  let bd = body;

  for (const [field, rawValue] of Object.entries(edits)) {
    if (field === 'body') {
      bd = rawValue;
      continue;
    }

    if (field === 'genres') {
      const arr = rawValue
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const lines = fm.split('\n');
      const out: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^genres:\s*$/.test(line)) {
          i++;
          while (i < lines.length && /^\s+-/.test(lines[i] ?? '')) i++;
          continue;
        }
        if (/^genres:\s*\[\s*\]\s*$/.test(line)) {
          i++;
          continue;
        }
        out.push(line);
        i++;
      }
      if (arr.length > 0) {
        out.push('genres:');
        for (const g of arr) out.push(`  - ${g}`);
      } else {
        out.push('genres: []');
      }
      fm = out.join('\n');
      continue;
    }

    if (field === 'studios') {
      const arr = rawValue
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const lines = fm.split('\n');
      const out: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^studios:\s*$/.test(line)) {
          i++;
          while (i < lines.length && /^\s+-/.test(lines[i] ?? '')) i++;
          continue;
        }
        if (/^studios:\s*\[\s*\]\s*$/.test(line)) {
          i++;
          continue;
        }
        out.push(line);
        i++;
      }
      if (arr.length > 0) {
        out.push('studios:');
        for (const s of arr) out.push(`  - ${s}`);
      } else {
        out.push('studios: []');
      }
      fm = out.join('\n');
      continue;
    }

    const value = yamlSafeString(rawValue);
    fm = setFrontmatterField(fm, field, value);
  }

  return joinContent(fm, bd);
}