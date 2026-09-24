#!/usr/bin/env node
/**
 * reqable-cli entry point.
 *
 * Keeps no state and prints nothing of its own: src/cli.js owns both the
 * output contract and the exit code.
 */

import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
