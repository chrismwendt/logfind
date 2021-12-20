import Parser, { SyntaxNode } from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import { Command, InvalidArgumentError } from 'commander'
import fs from 'fs'
import path from 'path'
import wildcardMatch from 'wildcard-match'
import chalk from 'chalk'

const main = async () => {
  const program = new Command()
  program.option('--string <string>', 'string to reverse search for')
  program.option('--directory [directory]', 'where to search', process.cwd())
  program.option('--context [context]', 'show lines above and below matches', commanderParseInt, 2)
  program.parse(process.argv)
  const opts: Options = program.opts()

  for await (const hit of await asyncGeneratorToArray(search(opts.string, opts.directory))) {
    console.log(`${chalk.magenta(`${hit.file}:${hit.node.startPosition.row}`)}`)

    const lineNumberWidth = hit.node.endPosition.row.toString().length
    const contents = (await fs.promises.readFile(path.join(opts.directory, hit.file))).toString()
    const contentsLines = contents.split('\n')
    let preview = ''
    preview +=
      contentsLines
        .slice(Math.max(0, hit.node.startPosition.row - opts.context), hit.node.startPosition.row)
        .join('\n') + '\n'
    preview += contentsLines[hit.node.startPosition.row].slice(0, hit.node.startPosition.column)
    preview += chalk.red(contents.slice(hit.node.startIndex, hit.node.endIndex))
    preview += contentsLines[hit.node.endPosition.row].slice(hit.node.endPosition.column)
    preview +=
      '\n' +
      contentsLines
        .slice(hit.node.endPosition.row+1, hit.node.endPosition.row + opts.context + 1)
        .join('\n')
    const previewLines = preview.split('\n')
    for (let i = 0; i < previewLines.length; i++) {
      const lineNumber = hit.node.startPosition.row + i
      console.log(
        `${chalk.green(`${lineNumber.toString().padEnd(lineNumberWidth)}`)} ${chalk.gray('|')} ${previewLines[i]}`
      )
    }
    console.log()
  }

  console.log('Done searching.')
}

const mainTest = async () => {
  const parser = new Parser()
  parser.setLanguage(JavaScript)
  for (const line of searchInFile(parser, 'const x = `aaa${3}zzz`', 'aaa garbage goes here zzz')) {
    console.log(line)
  }
}

type Options = {
  string: string
  directory: string
  context: number
}

type Hit = {
  file: string
  node: SyntaxNode
}

const search = async function* (query: string, directory: string): AsyncGenerator<Hit, void, unknown> {
  const parser = new Parser()
  parser.setLanguage(JavaScript)

  for await (const filepath of walk(directory)) {
    if (!filepath.endsWith('.js')) {
      continue
    }

    const contents = (await fs.promises.readFile(filepath)).toString()

    for (const node of searchInFile(parser, contents, query)) {
      yield { file: path.relative(directory, filepath), node }
    }
  }
}

const searchInFile = function* (parser: Parser, contents: string, query: string): Generator<SyntaxNode, void, unknown> {
  const tree = parser.parse(contents)

  const lines = contents.split('\n')
  const generator = traverse(tree.rootNode)
  let next = generator.next()
  while (!next.done) {
    const node = next.value
    switch (node.type) {
      case 'string':
        const value = node.text.slice(1, -1)
        if (value.includes(query)) {
          yield node
        }
        next = generator.next('skip')
        break
      case 'template_string':
        const pattern = windows(2, node.children)
          .map(([a, b]) => contents.slice(a.endIndex, b.startIndex))
          .map(t => t.replaceAll('?', '\\?').replaceAll('*', '\\*'))
          .join('*')
        if (wildcardMatch(pattern, false)(query)) {
          yield node
        }
        next = generator.next('skip')
        break
      default:
        next = generator.next('go deeper')
        break
    }
  }
}

const windows = <T>(n: number, ts: T[]): T[][] => {
  const tss = []
  for (let i = 0; i < ts.length - n + 1; i++) {
    tss.push(ts.slice(i, i + n))
  }
  return tss
}

async function* walk(directory: string): AsyncGenerator<string, void, unknown> {
  for await (const entry of await fs.promises.opendir(directory)) {
    if (entry.isDirectory()) yield* walk(path.join(directory, entry.name))
    else if (entry.isFile()) yield path.join(directory, entry.name)
  }
}

type Response = 'go deeper' | 'skip'

const traverse = function* (root: SyntaxNode): Generator<SyntaxNode, void, Response> {
  for (const child of root.children) {
    const response = yield child
    switch (response) {
      case 'go deeper':
        yield* traverse(child)
        break
      case 'skip':
        break
      default:
        const invalid: never = response
        break
    }
  }
}

async function asyncGeneratorToArray<T>(asyncGenerator: AsyncGenerator<T, any, any>): Promise<T[]> {
  const ts: T[] = []
  for await (const t of asyncGenerator) ts.push(t)
  return ts
}

function commanderParseInt(value: string) {
  // parseInt takes a string and a radix
  const parsedValue = parseInt(value, 10)
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError('Not a number.')
  }
  return parsedValue
}

main()
