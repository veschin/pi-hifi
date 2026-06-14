// Free (no-LLM) check of the generator code convention (3.5). Default (polyglot
// off) MUST stay byte-for-byte the legacy JS convention so the published eval
// stays comparable; polyglot on emits a language-tagged convention listing the
// real local runners (derived from runner.ts, so it cannot drift).
//
// Run: npx tsx eval/generator-selftest.ts

import { generatorSystem, analystSystem } from "../src/prompts.ts";
import { supportedLanguages } from "../src/runner.ts";

function line(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -  ${detail}`);
  return ok;
}

function main(): void {
  const r: boolean[] = [];

  // Default (polyglot off) = legacy JS convention, and the optional arm with
  // explicit false is byte-identical to the no-arg call (eval comparability).
  const jsDefault = generatorSystem("code");
  const jsExplicit = generatorSystem("code", false);
  r.push(
    line(
      "code default = legacy JS convention (eval-safe)",
      jsDefault === jsExplicit && jsDefault.includes("```js solution") && jsDefault.includes('"./solution.mjs"'),
      jsDefault.includes("```js solution") ? "js convention present" : "MISSING js convention",
    ),
  );

  // Polyglot on = language-tagged convention naming every local runner.
  const poly = generatorSystem("code", true);
  const langs = supportedLanguages(); // ["node", "python"]
  r.push(
    line(
      "code polyglot = language-tagged + all runners + ship-flag",
      poly.includes("```<lang> solution") &&
        langs.every((l) => poly.includes(l)) &&
        /not\s+executed/i.test(poly) &&
        !poly.includes("```js solution"),
      `tagged=${poly.includes("```<lang> solution")} runners=[${langs.join(",")}] all-present=${langs.every((l) => poly.includes(l))}`,
    ),
  );

  // Non-code modes are unaffected by the polyglot flag.
  r.push(
    line(
      "design/incident unaffected by polyglot",
      generatorSystem("design") === generatorSystem("design", true) &&
        generatorSystem("incident") === generatorSystem("incident", true),
      "non-code modes stable",
    ),
  );

  // The analyst's scope guidance MUST agree with the generator (critic finding):
  // polyglot off -> JS-only steering; polyglot on -> language-agnostic, no
  // node-verifiable steering, so it never constrains a non-JS task to JS.
  {
    const aOff = analystSystem(false);
    const aOn = analystSystem(true);
    r.push(
      line(
        "analyst scope agrees with generator polyglot",
        /JavaScript solution/.test(aOff) &&
          /node-verifiable/.test(aOff) &&
          /LANGUAGE\s+THE\s+TASK\s+REQUIRES/i.test(aOn) &&
          !/node-verifiable/.test(aOn) &&
          /not\s+executed/i.test(aOn),
        `off=JS-steered on=language-agnostic`,
      ),
    );
  }

  const ok = r.every(Boolean);
  console.log(ok ? "GENERATOR-SELFTEST PASSED: code + analyst convention gating correct" : "GENERATOR-SELFTEST FAILED");
  if (!ok) process.exitCode = 1;
}

main();
