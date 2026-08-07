import { describe as suite, expect, it } from 'vitest';

import { wikiToMarkdown } from './wiki.js';

suite('wikiToMarkdown', () => {
  it('converts headings', () => {
    expect(wikiToMarkdown('h1. Title\nh3. Sub')).toBe('# Title\n### Sub');
  });

  it('converts emphasis', () => {
    expect(wikiToMarkdown('a *bold* and _italic_ and -gone- and +new+ word')).toBe(
      'a **bold** and _italic_ and ~~gone~~ and new word',
    );
  });

  it('leaves markers that do not hug a word alone', () => {
    // Multiplication and snake_case are not emphasis.
    expect(wikiToMarkdown('2*3*4 stays, so does file_name_here')).toBe(
      '2*3*4 stays, so does file_name_here',
    );
  });

  it('converts links and bare urls', () => {
    expect(wikiToMarkdown('see [the docs|https://example.test/a] and [https://example.test]')).toBe(
      'see [the docs](https://example.test/a) and <https://example.test>',
    );
  });

  it('converts inline code and protects its content', () => {
    expect(wikiToMarkdown('run {{npm run *build*}} now')).toBe('run `npm run *build*` now');
  });

  it('converts code blocks with their language', () => {
    expect(wikiToMarkdown('{code:java}\nint a = 1;\n{code}')).toBe('```java\nint a = 1;\n```');
    expect(wikiToMarkdown('{code:title=Foo|language=bash}\nls\n{code}')).toBe('```bash\nls\n```');
    expect(wikiToMarkdown('{noformat}\nplain\n{noformat}')).toBe('```\nplain\n```');
  });

  it('does not rewrite anything inside a code block', () => {
    expect(wikiToMarkdown('{code}\nh1. not a heading\n* not a list\n{code}')).toBe(
      '```\nh1. not a heading\n* not a list\n```',
    );
  });

  it('converts nested lists', () => {
    expect(wikiToMarkdown('* one\n** deeper\n# first\n## second')).toBe(
      '- one\n  - deeper\n1. first\n  1. second',
    );
  });

  it('converts quotes', () => {
    expect(wikiToMarkdown('bq. quoted')).toBe('> quoted');
    expect(wikiToMarkdown('{quote}\nline one\nline two\n{quote}')).toBe('> line one\n> line two');
  });

  it('converts tables', () => {
    expect(wikiToMarkdown('||Key||Value||\n|a|1|\n|b|2|')).toBe(
      '| Key | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |',
    );
  });

  it('converts images and rules', () => {
    expect(wikiToMarkdown('!diagram.png|thumbnail!')).toBe('![diagram.png](diagram.png)');
    expect(wikiToMarkdown('----')).toBe('---');
  });

  it('drops macros that carry no meaning in markdown', () => {
    expect(wikiToMarkdown('{color:red}urgent{color}')).toBe('urgent');
  });

  it('leaves plain text and existing markdown untouched', () => {
    // A Jira site can hold markdown-looking text; nothing here should change it.
    expect(wikiToMarkdown('Just a sentence, with a comma.')).toBe('Just a sentence, with a comma.');
  });
});
