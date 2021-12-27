import type { Denops } from "https://deno.land/x/denops_std@v2.2.0/mod.ts";
import { execute } from "https://deno.land/x/denops_std@v2.2.0/helper/mod.ts";
import * as helper from "https://deno.land/x/denops_std@v2.2.0/helper/mod.ts";
import { Fzf } from "https://esm.sh/fzf@0.4.1";
import {
  ensureNumber,
  ensureString,
  isNumber,
  isString,
} from "https://deno.land/x/unknownutil@v1.1.4/mod.ts";

type Mode = "prev" | "next" | "all";

type WordPos = {
  line: number;
  col: number;
};

type Word = {
  text: string;
  pos: WordPos;
};

type Target = Word & {
  char: string;
};

type Extmark = [number, number, number, { virt_text: Array<[string, string]> }];

const ENTER = 13;
const ESC = 27;
const BS = 128;
const C_H = 8;
const TARGET_LENGTH = 26;

let input = "";

const getStartAndEndLine = async (denops: Denops, mode: Mode) => {
  const startLine = await denops.call(
    "line",
    mode === "next" ? "." : "w0",
  ) as number;
  const endLine = await denops.call(
    "line",
    mode === "prev" ? "." : "w$",
  ) as number;

  return {
    startLine,
    endLine,
  };
};

const getWords = async (
  denops: Denops,
  mode: Mode,
): Promise<ReadonlyArray<Word>> => {
  const { startLine, endLine } = await getStartAndEndLine(denops, mode);

  const lines = await denops.call(
    "getline",
    startLine,
    endLine,
  ) as ReadonlyArray<string>;

  const regexp = new RegExp("[0-9a-zA-Z_-]+", "gu");

  let words: ReadonlyArray<Word> = [];
  let matchArray: RegExpExecArray | null = null;

  for (const [lineNumber, line] of lines.entries()) {
    while ((matchArray = regexp.exec(line)) != null) {
      words = [...words, {
        text: line.slice(matchArray.index, regexp.lastIndex),
        pos: {
          line: lineNumber + startLine,
          col: matchArray.index + 1,
        },
      }];
    }
  }

  return words;
};

const removeExtMarks = async (denops: Denops, namespace: number) => {
  const oldExtmarks = await denops.call(
    "nvim_buf_get_extmarks",
    0,
    namespace,
    0,
    -1,
    { details: true },
  ) as Array<Extmark>;
  await Promise.all(oldExtmarks.map(async (oldMark) => {
    await denops.call(
      "nvim_buf_del_extmark",
      0,
      namespace,
      oldMark[0],
    );
  }));
};

const renderExtMarks = async (
  denops: Denops,
  namespace: number,
  targets: Array<Target>,
) => {
  for (const target of targets) {
    await denops.call(
      "nvim_buf_set_extmark",
      0,
      namespace,
      target.pos.line - 1,
      target.pos.col - 2 >= 0 ? target.pos.col - 2 : target.pos.col - 1,
      {
        virt_text: [[
          target.char,
          "FuzzyMotionChar",
        ]],
        virt_text_pos: "overlay",
        hl_mode: "combine",
      },
    );
  }
};

export const main = async (denops: Denops): Promise<void> => {
  const namespace = await denops.call(
    "nvim_create_namespace",
    "fuzzy-motion",
  ) as number;

  await helper.execute(
    denops,
    `
    command! -nargs=? FuzzyMotion     call denops#request("${denops.name}", "execute", ['all', <q-args>])
    command! -nargs=? FuzzyMotionNext call denops#request("${denops.name}", "execute", ['next', <q-args>])
    command! -nargs=? FuzzyMotionPrev call denops#request("${denops.name}", "execute", ['prev', <q-args>])
    `,
  );

  denops.dispatcher = {
    execute: async (mode: unknown, defaultInput: unknown): Promise<void> => {
      ensureString(mode);
      ensureString(defaultInput);
      if (
        !isString(mode) ||
        (mode !== "prev" && mode !== "next" && mode !== "all")
      ) {
        return;
      }

      let useDefaultInput = defaultInput !== "";

      const pos = await denops.call("getpos", ".") as [
        number,
        number,
        number,
        number,
      ];
      const currentLineText = await denops.call("getline", pos[1]) as string;
      const { startLine, endLine } = await getStartAndEndLine(denops, mode);

      let matchIds: Array<number> = [];
      matchIds = [
        ...matchIds,
        await denops.call(
          "matchaddpos",
          "FuzzyMotionShade",
          [[
            pos[1],
            mode === "prev" ? 1 : pos[2],
            mode === "prev" ? pos[2] : currentLineText.length,
          ]],
          10,
        ) as number,
      ];

      const lineNumbers = [
        ...Array(
          mode === "all" ? (endLine + startLine + 1) : (endLine - startLine),
        ),
      ].map((_, i) =>
        i + startLine + (mode === "prev" || mode === "all" ? 0 : 1)
      );
      matchIds = [
        ...matchIds,
        ...await Promise.all(lineNumbers.map(async (lineNumber) => {
          return await denops.call(
            "matchaddpos",
            "FuzzyMotionShade",
            [lineNumber],
            10,
          ) as number;
        })),
      ];

      await execute(denops, `redraw`);

      input = defaultInput;
      let targets: Array<Target> = [];

      const words = await getWords(denops, mode as Mode);
      const fzf = new Fzf(words, {
        selector: (word) => word.text,
      });

      try {
        await execute(denops, `echo 'fuzzy-motion: ${input}'`);
        await execute(denops, `redraw`);

        while (true) {
          let code: number;
          if (!useDefaultInput) {
            code = await denops.call("getchar") as number;
            if (code == null) {
              code = 0;
            } else if (code === ENTER) {
              code = 65;
            }
          } else {
            useDefaultInput = false;
            code = 0;
          }

          if (!isNumber(code)) {
            code = await denops.call("char2nr", code) as number;
          }
          ensureNumber(code);

          if (code === ESC) {
            break;
          } else if (code >= "A".charCodeAt(0) && code <= "Z".charCodeAt(0)) {
            const targetChar = String.fromCharCode(code);
            const target = targets.find((target) => target.char === targetChar);

            if (target != null) {
              await execute(denops, "normal! m`");
              await denops.call("cursor", target.pos.line, target.pos.col);
              break;
            }
          } else if (code === BS || code === C_H) {
            await removeExtMarks(denops, namespace);

            input = input.slice(0, -1);
            await execute(denops, `echo 'fuzzy-motion: ${input}'`);
            await execute(denops, `redraw`);
            if (input === "") {
              continue;
            }

            targets = fzf.find(input).slice(0, TARGET_LENGTH).map<Target>(
              (entry, i) => {
                return {
                  text: entry.item.text,
                  pos: entry.item.pos,
                  char: String.fromCharCode("A".charCodeAt(0) + i),
                };
              },
            );

            await renderExtMarks(denops, namespace, targets);
            await execute(denops, `echo 'fuzzy-motion: ${input}'`);
            await execute(denops, `redraw`);
          } else if (
            (code >= "a".charCodeAt(0) && code <= "z".charCodeAt(0)) ||
            (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) ||
            code === "_".charCodeAt(0) || code === "-".charCodeAt(0) ||
            defaultInput !== ""
          ) {
            await removeExtMarks(denops, namespace);

            input = `${input}${code !== 0 ? String.fromCharCode(code) : ""}`;
            targets = fzf.find(input).slice(0, TARGET_LENGTH).map<Target>(
              (entry, i) => {
                return {
                  text: entry.item.text,
                  pos: entry.item.pos,
                  char: String.fromCharCode("A".charCodeAt(0) + i),
                };
              },
            );

            await renderExtMarks(denops, namespace, targets);
            await execute(denops, `echo 'fuzzy-motion: ${input}'`);
            await execute(denops, `redraw`);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        await Promise.all(matchIds.map((id) => {
          denops.call("matchdelete", id);
        }));

        await removeExtMarks(denops, namespace);

        await execute(denops, `echo ''`);
        await execute(denops, `redraw`);
      }
    },
  };

  return await Promise.resolve();
};
