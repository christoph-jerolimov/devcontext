/**
 * Converts Jira wiki markup — the plain text format the Jira REST API v2
 * returns, which Jira Data Center and Server still speak — into markdown.
 *
 * ADF (API v3, Jira Cloud) is handled by `adfToMarkdown`. Between the two,
 * every description and comment in the database is markdown, so exports and
 * the web viewer only ever deal with one format.
 */
export function wikiToMarkdown(input: string): string {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;

    // {code:java} ... {code} and {noformat} ... {noformat} become fences.
    const fence = /^\{(code|noformat)(?::([^}]*))?\}\s*$/.exec(line.trim());
    if (fence) {
      const language = fence[1] === 'code' ? languageOf(fence[2]) : '';
      const body: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !/^\{(code|noformat)\}\s*$/.test((lines[index] as string).trim())
      ) {
        body.push(lines[index] as string);
        index += 1;
      }
      out.push(`\`\`\`${language}`, ...body, '```');
      continue;
    }

    // {quote} ... {quote}
    if (/^\{quote\}\s*$/.test(line.trim())) {
      index += 1;
      while (index < lines.length && !/^\{quote\}\s*$/.test((lines[index] as string).trim())) {
        out.push(`> ${convertInline(lines[index] as string)}`);
        index += 1;
      }
      continue;
    }

    out.push(convertBlock(line));
  }

  return out.join('\n').trim();
}

function convertBlock(line: string): string {
  // h1. Heading -> # Heading
  const heading = /^h([1-6])\.\s*(.*)$/.exec(line);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${convertInline(heading[2] ?? '')}`;

  // ---- (four or more) is a rule; Jira also accepts a bare "----".
  if (/^-{4,}\s*$/.test(line)) return '---';

  // Nested lists: "**" / "##" / "#*" mark the depth, one marker per level.
  const list = /^([*#-]+)\s+(.*)$/.exec(line);
  if (list) {
    const markers = list[1] as string;
    const indent = '  '.repeat(markers.length - 1);
    const bullet = markers.endsWith('#') ? '1.' : '-';
    return `${indent}${bullet} ${convertInline(list[2] ?? '')}`;
  }

  // bq. quoted line
  const quote = /^bq\.\s*(.*)$/.exec(line);
  if (quote) return `> ${convertInline(quote[1] ?? '')}`;

  // Tables: ||header||header|| and |cell|cell|
  if (/^\s*\|\|.*\|\|\s*$/.test(line)) {
    const cells = splitRow(line, '||');
    return [
      `| ${cells.map((cell) => convertInline(cell)).join(' | ')} |`,
      `| ${cells.map(() => '---').join(' | ')} |`,
    ].join('\n');
  }
  if (/^\s*\|.*\|\s*$/.test(line)) {
    return `| ${splitRow(line, '|')
      .map((cell) => convertInline(cell))
      .join(' | ')} |`;
  }

  return convertInline(line);
}

function splitRow(line: string, separator: '|' | '||'): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(separator.length, trimmed.length - separator.length);
  return inner.split(separator).map((cell) => cell.trim());
}

function convertInline(text: string): string {
  let result = text;

  // Inline code is pulled out first, behind a private use area sentinel that
  // real text does not contain, so none of the rules below can rewrite what is
  // inside it.
  const code: string[] = [];
  result = result.replace(/\{\{(.+?)\}\}/g, (_match, inner: string) => {
    code.push(inner);
    return `\uE000${code.length - 1}\uE000`;
  });

  // [text|https://url] and [https://url]
  result = result.replace(/\[([^\]|]+)\|([^\]]+)\]/g, '[$1]($2)');
  result = result.replace(/\[((?:https?|mailto):[^\]]+)\]/g, '<$1>');

  // !image.png! and !image.png|thumbnail!
  result = result.replace(/!([^!|\s]+)(\|[^!]*)?!/g, '![$1]($1)');

  // Emphasis. The markers only count when they hug a word, so `2*3*4` and
  // file_name_here are left alone.
  result = result.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,;:!?]|$)/g, '$1**$2**');
  result = result.replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=[\s).,;:!?]|$)/g, '$1_$2_');
  result = result.replace(/(^|[\s(])-(\S(?:[^-\n]*\S)?)-(?=[\s).,;:!?]|$)/g, '$1~~$2~~');
  result = result.replace(/(^|[\s(])\+(\S(?:[^+\n]*\S)?)\+(?=[\s).,;:!?]|$)/g, '$1$2');
  result = result.replace(/(^|[\s(])\?\?(\S(?:[^?\n]*\S)?)\?\?(?=[\s).,;:!?]|$)/g, '$1_$2_');

  // Colour and anchor macros carry no meaning in markdown.
  result = result.replace(/\{color(?::[^}]*)?\}/g, '');
  result = result.replace(/\{anchor:[^}]*\}/g, '');

  return result.replace(
    /\uE000(\d+)\uE000/g,
    (_match, index: string) => `\`${code[Number(index)]}\``,
  );
}

/** `{code:title=Foo|language=java}` and `{code:java}` both name a language. */
function languageOf(attributes: string | undefined): string {
  if (!attributes) return '';
  for (const part of attributes.split('|')) {
    const [key, value] = part.split('=');
    if (value !== undefined) {
      if (key?.trim() === 'language') return value.trim();
      continue;
    }
    if (key && !key.includes('=')) return key.trim();
  }
  return '';
}
