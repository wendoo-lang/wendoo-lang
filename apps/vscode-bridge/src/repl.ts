import repl from "node:repl";
import { runReplCommand } from "./repl-commands.js";
import type { BridgeAdmin } from "./server.js";

/** Options for {@link startRepl}. */
export interface ReplOptions {
  /** The session operations the console's commands use. */
  admin: BridgeAdmin;
  /** Called once, when the console exits. */
  onExit: () => void;
  /** Where the console reads its input. Defaults to standard input. */
  input?: NodeJS.ReadableStream;
  /** Where the console writes its prompt and answers. Defaults to standard output. */
  output?: NodeJS.WritableStream;
}

/**
 * Starts the development console, which answers each line it reads with
 * {@link runReplCommand} and calls `onExit` when it exits.
 */
export function startRepl(options: ReplOptions): void {
  const output = options.output ?? process.stdout;
  const shell = repl.start({
    prompt: "bridge> ",
    input: options.input ?? process.stdin,
    output,
    ignoreUndefined: true,
    eval(input, _context, _filename, callback) {
      const answer = runReplCommand(input, options.admin);
      if (answer !== undefined) output.write(`${answer}\n`);
      callback(null, undefined);
    },
  });
  shell.on("exit", options.onExit);
}
