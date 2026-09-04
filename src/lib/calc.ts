// Calculator (calculator-tool): the SYSTEM_PROMPT routes ALL arithmetic to an inline LLM answer, which
// is fine for "20% of $47" but silently WRONG for chained or financial math ("split $127.50 three ways
// with 20% tip", "monthly payment on a $30k loan at 6% for 5 years") — the highest-frequency errand
// class through an unverified path. This is a SAFE deterministic evaluator (no eval/Function): a
// tokenizer + shunting-yard to RPN + an RPN evaluator, supporting + - * / % ^, parens, unary minus, a
// trailing "% of"/"x% off" idiom, and a small set of named functions (sqrt/round/abs/min/max/pow/
// loanpayment). Pure; unit-tested. Returns a number or throws a friendly Error the tool surfaces.

export type Token = { t: "num"; v: number } | { t: "op"; v: string } | { t: "fn"; v: string; argc?: number } | { t: "paren"; v: "(" | ")" } | { t: "comma" };

const FUNCS = new Set(["sqrt", "abs", "round", "floor", "ceil", "min", "max", "pow", "loanpayment", "fact", "compound", "simple"]);
// operator precedence + right-assoc flag. Unary minus is handled as a special "neg" op at parse time.
const OPS: Record<string, { prec: number; right?: boolean }> = {
  "+": { prec: 2 }, "-": { prec: 2 }, "*": { prec: 3 }, "/": { prec: 3 }, "%": { prec: 3 },
  "^": { prec: 4, right: true }, neg: { prec: 5, right: true },
};

/** Normalize a raw math string: strip $ and thousands commas + collapse spaces. Word operators
 * (times/plus/divided by) and the percent idioms are handled by the tokenizer. Exported for tests. */
export function normalizeExpr(raw: string): string {
  return String(raw ?? "")
    .replace(/[$£€]/g, "")
    // Strip ONLY thousands-separator commas (a digit, then a comma, then exactly 3 digits) — keep
    // argument-separator commas ("max(1, 2, 3)") so the parser can count function arity.
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/\bdivided by\b/gi, "/").replace(/\btimes\b|\bmultiplied by\b/gi, "*")
    .replace(/\bplus\b/gi, "+").replace(/\bminus\b/gi, "-")
    .replace(/\bto the power of\b|\braised to\b/gi, "^")
    .replace(/\bmod(?:ulo)?\b/gi, " mod ")
    .replace(/\s+/g, " ").trim();
}

/** Tokenize a normalized arithmetic expression. Handles numbers (incl. decimals), operators, parens,
 * function names, commas, and the "X% of Y" / "Y - X%" percent idioms (rewritten to explicit multiply).
 * Throws on an unknown character. Exported for tests. */
export function tokenize(input: string): Token[] {
  // Rewrite the percent idioms into plain arithmetic BEFORE tokenizing:
  //   "20% of 50" -> "(20/100)*50" ; "50 + 20%" / "50 plus 20%" -> "50*(1+20/100)" ; "50 - 20%" off ->
  //   "50*(1-20/100)". A bare trailing "%" elsewhere means /100.
  let s = " " + input.toLowerCase() + " "; // pad so a leading/trailing operator-word matches
  // Percent CHANGE from A to B (calc-percent-change): "50 to 75 percent change", "percent increase from
  // 50 to 75", "% change 100 to 90" -> ((B-A)/A)*100. Rewritten FIRST (before the words are stripped) into
  // a plain expression the evaluator handles; the "of"/"off" idioms below don't touch a change phrase.
  // Requires the "change/increase/decrease/percent/%" cue AND an "A to B" pair, so a plain "50 to 75"
  // (not a math request) isn't hijacked.
  if (/(?:\bpercent(?:age)?\b|%)/.test(s) && /\b(change|increase|decrease|difference|more|less|up|down|from)\b/.test(s)) {
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:to|->|→)\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const a = m[1]!, b = m[2]!;
      // Only when A != 0 (percent change off zero is undefined); leave it to error otherwise.
      if (parseFloat(a) !== 0) return tokenize(`((${b}-${a})/${a})*100`); // re-tokenize the plain expr
    }
  }
  // "X% tip on Y" / "X% gratuity on Y" -> the TIP AMOUNT (Y * X/100), matching the SYSTEM_PROMPT's
  // "20% tip on $47 = $9.40" (calc-tip-idiom). Rewritten before the modulo/percent passes so the "%"
  // isn't misread as an operator. "tip"/"gratuity" are the only words the tokenizer would otherwise
  // reject; this turns the natural phrasing into plain arithmetic instead of erroring on "tip".
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*(?:tip|gratuity)\s+on\s+(\d+(?:\.\d+)?)/g, "($1/100)*($2)");
  s = s.replace(/ mod /g, " MODOP "); // temp %-free sentinel for modulo so the percent rewrites below cannot eat a % char
  // A bare "%" used as an operator BETWEEN two operands ("17 % 5", "17 % (2+3)") is modulo, not a
  // percentage — the percent idioms below only make sense when "%" TRAILS a number ("20% of", "50 - 20%").
  // Route the operator form to the same MODOP sentinel so it survives the percent rewrites.
  s = s.replace(/%\s*(?=[0-9(])/g, " MODOP ");
  // Percent-FIRST discount idiom: "20% off 50" -> "50*(1-20/100)" (the common phrasing; the sign-based
  // rewrite below only catches "50 - 20% off"). Checked before "% of" so "off" isn't misread (calc-pct-off-first).
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*off\b\s*(\d+(?:\.\d+)?)/g, "($2)*(1-$1/100)");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*of\b\s*/g, "($1/100)*"); // \bof\b so "% off" isn't read as "% of f"
  s = s.replace(/([\d.)+\-*/^ ]+?)\s*([+\-])\s*(\d+(?:\.\d+)?)\s*%(?:\s*(off))?/g, (_m, base, sign, pct, off) => {
    const op = off ? "-" : sign; // "X - 20% off" and "X - 20%" both subtract; "X + 20%" adds
    return `(${base})*(1${op}${pct}/100)`;
  });
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)"); // any remaining bare percent -> /100
  s = s.replace(/MODOP/g, "%"); // restore modulo to the % operator (tokenized as op %)
  // Factorial: a trailing "!" after a number -> fact(...) (calc-factorial). "5!" -> "fact(5)". Done after
  // the percent passes so a "%" can't be swept into the group. Only the bare-number form (the common one);
  // "(2+3)!" is left unhandled (a following pass would error) rather than risk a wrong rewrite.
  s = s.replace(/(\d+(?:\.\d+)?)\s*!/g, "fact($1)");

  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " ") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      // Scientific notation: a trailing "e"/"E" followed by an optional sign + digits ("1e3", "2.5e-4",
      // "6.02e23") is part of the number (calc-sci-notation) — otherwise "e" tokenized as an unknown
      // name and the calc errored. Only consume "e" when real digits follow, so "e" alone still errors.
      if ((s[j] === "e") && /[0-9]/.test(s[j + 1] ?? "") || (s[j] === "e" && (s[j + 1] === "+" || s[j + 1] === "-") && /[0-9]/.test(s[j + 2] ?? ""))) {
        j++; // consume 'e'
        if (s[j] === "+" || s[j] === "-") j++;
        while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      }
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`Bad number: "${s.slice(i, j)}"`);
      out.push({ t: "num", v: num }); i = j; continue;
    }
    if (/[a-z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[a-z]/.test(s[j]!)) j++;
      const name = s.slice(i, j);
      if (!FUNCS.has(name)) throw new Error(`I don't know "${name}".`);
      out.push({ t: "fn", v: name }); i = j; continue;
    }
    if (c === "(") { out.push({ t: "paren", v: "(" }); i++; continue; }
    if (c === ")") { out.push({ t: "paren", v: ")" }); i++; continue; }
    if (c === ",") { out.push({ t: "comma" }); i++; continue; }
    if ("+-*/%^".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}".`);
  }
  return out;
}

/** Shunting-yard: token stream -> RPN, resolving unary minus + function arity. Throws on mismatched
 * parens. Exported for tests. */
export function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];
  // Track arg counts for the fn currently being parsed (top = innermost). A fn seeds a count of 1 when
  // it gets a "("; every comma at that depth bumps it. So max(1,2,3) records argc:3 -> the evaluator
  // folds exactly that many operands instead of assuming a fixed arity.
  const argc: number[] = [];
  let prevMeaningful: Token | null = null; // to detect unary minus (start / after op / after "(")
  for (const tok of tokens) {
    if (tok.t === "num") { output.push(tok); }
    else if (tok.t === "fn") { stack.push(tok); }
    else if (tok.t === "comma") {
      while (stack.length && !(stack[stack.length - 1]!.t === "paren")) output.push(stack.pop()!);
      if (argc.length) argc[argc.length - 1]!++;
    }
    else if (tok.t === "op") {
      const isUnary = tok.v === "-" && (prevMeaningful === null || prevMeaningful.t === "op" || (prevMeaningful.t === "paren" && prevMeaningful.v === "(") || prevMeaningful.t === "comma");
      const op = isUnary ? "neg" : tok.v;
      const o1 = OPS[op]!;
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        if (top.t !== "op") break;
        const o2 = OPS[top.v]!;
        if (o2.prec > o1.prec || (o2.prec === o1.prec && !o1.right)) output.push(stack.pop()!);
        else break;
      }
      stack.push({ t: "op", v: op });
    }
    else if (tok.t === "paren" && tok.v === "(") { stack.push(tok); argc.push(1); }
    else if (tok.t === "paren" && tok.v === ")") {
      while (stack.length && !(stack[stack.length - 1]!.t === "paren")) output.push(stack.pop()!);
      if (!stack.length) throw new Error("Mismatched parentheses.");
      stack.pop(); // discard "("
      const n = argc.pop() ?? 1; // args this paren enclosed (1 + comma count at this depth)
      // Empty "()" (fn with no args) records 0, not the seeded 1.
      const emptyCall = prevMeaningful?.t === "paren" && prevMeaningful.v === "(";
      if (stack.length && stack[stack.length - 1]!.t === "fn") {
        const fn = stack.pop() as Extract<Token, { t: "fn" }>;
        output.push({ ...fn, argc: emptyCall ? 0 : n });
      }
    }
    prevMeaningful = tok;
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top.t === "paren") throw new Error("Mismatched parentheses.");
    output.push(top);
  }
  return output;
}

/** Evaluate an RPN token stream to a number. Throws on malformed input / divide-by-zero. Exported. */
export function evalRpn(rpn: Token[]): number {
  const st: number[] = [];
  const bin = (fn: (a: number, b: number) => number) => { const b = st.pop(), a = st.pop(); if (a === undefined || b === undefined) throw new Error("Malformed expression."); st.push(fn(a, b)); };
  for (const tok of rpn) {
    if (tok.t === "num") { st.push(tok.v); continue; }
    if (tok.t === "op") {
      switch (tok.v) {
        case "+": bin((a, b) => a + b); break;
        case "-": bin((a, b) => a - b); break;
        case "*": bin((a, b) => a * b); break;
        case "/": bin((a, b) => { if (b === 0) throw new Error("Can't divide by zero."); return a / b; }); break;
        case "%": bin((a, b) => { if (b === 0) throw new Error("Can't mod by zero."); return a % b; }); break;
        case "^": bin((a, b) => a ** b); break;
        case "neg": { const a = st.pop(); if (a === undefined) throw new Error("Malformed expression."); st.push(-a); break; }
        default: throw new Error(`Unknown operator ${tok.v}.`);
      }
      continue;
    }
    if (tok.t === "fn") {
      // Pop exactly `n` operands (the recorded arity) as this call's args, left-to-right.
      const argc = tok.argc;
      const popN = (n: number): number[] => {
        const args: number[] = [];
        for (let k = 0; k < n; k++) { const a = st.pop(); if (a === undefined) throw new Error("Malformed expression."); args.unshift(a); }
        return args;
      };
      const need = (n: number, name: string) => { if (argc !== undefined && argc !== n) throw new Error(`${name} takes ${n} argument${n === 1 ? "" : "s"}.`); return popN(n); };
      switch (tok.v) {
        case "sqrt": { const [a] = need(1, "sqrt"); st.push(Math.sqrt(a!)); break; }
        case "abs": { const [a] = need(1, "abs"); st.push(Math.abs(a!)); break; }
        case "round": { const [a] = need(1, "round"); st.push(Math.round(a!)); break; }
        case "floor": { const [a] = need(1, "floor"); st.push(Math.floor(a!)); break; }
        case "ceil": { const [a] = need(1, "ceil"); st.push(Math.ceil(a!)); break; }
        // min/max are variadic: fold however many args were passed (default 2 for a bare op-style call).
        case "min": { const args = popN(argc ?? 2); if (!args.length) throw new Error("min needs at least one number."); st.push(Math.min(...args)); break; }
        case "max": { const args = popN(argc ?? 2); if (!args.length) throw new Error("max needs at least one number."); st.push(Math.max(...args)); break; }
        case "pow": { const [a, b] = need(2, "pow"); st.push(a! ** b!); break; }
        // Factorial (calc-factorial): whole numbers 0..170 only (171! overflows to Infinity). A negative
        // or non-integer factorial isn't defined here — throw a friendly error rather than return NaN.
        case "fact": {
          const [a] = need(1, "fact");
          if (!Number.isInteger(a!) || a! < 0) throw new Error("Factorial needs a whole number ≥ 0.");
          if (a! > 170) throw new Error("That factorial is too big for me to compute.");
          let f = 1; for (let k = 2; k <= a!; k++) f *= k; st.push(f); break;
        }
        // loanpayment(principal, annualRatePct, years) -> monthly payment (amortized).
        case "loanpayment": {
          const [principal, ratePct, years] = need(3, "loanpayment");
          const r = ratePct! / 100 / 12, n = years! * 12;
          const pay = r === 0 ? principal! / n : (principal! * r) / (1 - Math.pow(1 + r, -n));
          st.push(pay); break;
        }
        // compound(principal, annualRatePct, years) -> the FINAL balance, compounded MONTHLY (the common
        // savings default). 3-arg only — a 4th "times/yr" arg is intentionally omitted (calc-interest):
        // the evaluator's variadic arity is unreliable past 3 args, so monthly-compounding keeps the answer
        // correct rather than risk a garbled 4-arg parse. (Annual/daily variants can be added if that's fixed.)
        case "compound": {
          const [principal, ratePct, years] = need(3, "compound");
          const nper = 12;
          st.push(principal! * Math.pow(1 + (ratePct! / 100) / nper, nper * years!)); break;
        }
        // simple(principal, annualRatePct, years) -> the FINAL balance with simple interest.
        case "simple": {
          const [principal, ratePct, years] = need(3, "simple");
          st.push(principal! * (1 + (ratePct! / 100) * years!)); break;
        }
        default: throw new Error(`Unknown function ${tok.v}.`);
      }
      continue;
    }
    throw new Error("Malformed expression.");
  }
  if (st.length !== 1) throw new Error("Malformed expression.");
  const r = st[0]!;
  if (!Number.isFinite(r)) throw new Error("That doesn't work out to a finite number.");
  return r;
}

/** Evaluate a free-text arithmetic expression to a number, or throw a friendly Error. Exported. */
export function calc(raw: string): number {
  const norm = normalizeExpr(raw);
  if (!norm) throw new Error("Give me something to calculate.");
  return evalRpn(toRpn(tokenize(norm)));
}

/** Format a computed result for display: integers plain, else up to 2 dp (trailing zeros trimmed). */
export function formatResult(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
