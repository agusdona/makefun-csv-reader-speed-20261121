// main.ts — the program the harness runs.
//
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// answers each one on its own with run(), and writes the JSON array of
// answers to $MAKEFUN_OUTPUT_DIR/answers.json (default /output).
//
// V8's incremental marking is turned off before solve.js is loaded, the way
// the house driver runs, so the scan spends its time on the text rather than
// on GC bookkeeping.

import { setFlagsFromString } from 'node:v8'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

setFlagsFromString('--no-incremental-marking')

const { run } = await import('./solve.js')

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input'
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output'

type Case = { id: string; input: { text: string; header: boolean } }

const cases: Case[] = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'))

const answers = new Array(cases.length)
for (let i = 0; i < cases.length; i += 1) {
  answers[i] = run(cases[i].input)
}

writeFileSync(outputDir + '/answers.json', JSON.stringify(answers))