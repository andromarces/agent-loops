# Closing block list rules

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a child report holds a list, or when `report` is null and `raw` carries the response. A block that lacks a required label is null, and `reportMissingLabels` names each missing label.

A child turn whose successful string response parses to a null report takes one repair turn in the same session. The repair asks for the closing block alone in a short canonical format and keeps the original findings, checks, and verdict. It runs inside the charged step, under the reviewer mutation check, and changes no work product. A reviewer repair runs under its own mutation check, so a write is still a mutation. A cancel that lands with a handled repair failure still ends the turn as a cancel. A repair that replaces the conversation keeps the replacement mark, so the next turn delivers the role preamble or task.

The repaired block is untrusted: a label that held a value must keep its normalized content, whatever list form it used. An absent label gains only `none`, and a reviewer verdict must match an explicit original verdict. An accept needs a non-empty original value for every required label and for `Checks`, so an empty original label cannot become acceptance evidence. A lost or replaced session, a failed repair, a null repair, and a mismatched repair leave the original response in `raw`. A cancel during the repair ends the turn as a cancel on the original error path, with no result and no `raw`. Per-adapter resume behavior is unverified until the live item in issue #710 records a result ([ADR 0094](https://github.com/andromarces/agent-loops/blob/main/adr/0094-repair-a-null-child-closing-block.md)).

A report that parses but lacks the reviewer `Checks` line or the `Verdict` line takes no repair. `acceptanceFailure` rejects that report: a missing `Verdict` yields `verdict`, and an accept without a `Checks` line yields `checks`. The repair handles only a null report.

Each value of `report.notes` and `report.deferred` is one line, the label plain at column 0. A `- `
list or an ordered `N. ` list (a `-` or a number and a period at column 0, exactly one space U+0020, then the item) that directly follows a report
label line is that label's value, or joins the value that line already holds:
the markers drop and the items join into one line with `; `. A list under `Blockers: none` therefore reads `none; <item>`, never
`none`. The reviewer `Verdict:` line is no report label, so a list after it
stays unparseable.

One nesting level folds too. A sub-item line holds spaces U+0020 up to the parent item text column,
then a marker, one space U+0020, then the item. The indent is the parent text column: `- ` takes two spaces, `1. a` three, and `10. a` four. The sub-item directly after a `- ` or `N. ` item joins it with `, `, and several
consecutive sub-items fold the same way. So `- a`, two spaces then `- b`, and two spaces then `- c`
read `a, b, c`. A sub-item under `1. a` takes three spaces, so `1. a` and
`   - b` read `a, b`.

An ordered sub-item at the parent text column folds the same way. So `- a`, two spaces then `1. b`, and two spaces then `2. c` read `a, b, c`. A sub-item marker need not match the parent item or its sibling sub-items. An ordered sub-item that opens with a report label name or `Verdict` line stays unparseable.

An indented non-list line (ASCII spaces or tabs, then text) directly after an item or its sub-items folds into that item with a space, so `- a`, `  - b`, and `  more` read `a, b more`. An indented line never folds when it reads as a label line: after NFKC normalization, it skips every leading character that is no letter or digit and one optional number, then holds a report label name or `Verdict`, any case, optional whitespace, and a character that is no letter, digit, or whitespace. Any colon variant (`:`, `：`, `∶`), any other separator, and any count or kind of markup around the name then refuse (`**Verdict:** x`, `Verdict***: x`, `1 Verdict: x`, and `> Verdict： x` after two spaces are examples), so the items after it stay unparseable lists. A label word that a letter follows (`Notes about x`), or whitespace and then a letter (`Why this matters:`), is prose and folds. An indented list line there is no continuation and stays unparseable.

The run ends at the first line that is not a `- ` or `N. ` item, a sub-item of the item above it, or an indented continuation line of that item, so a blank line or unindented prose between
the label and the list breaks it. Two shapes with a blank line fold anyway.

The first shape is one blank line after the label line, then a `- ` or `N. ` list directly under that blank
line. The items join the label value with `; `, so `Why: x`, a blank line, and `- a` read `x; a`. An
empty `Notes:` reads `a`. The list takes dash or ordered items. Two blank lines under the
label before the list stay unparseable.

The second shape has prose. A blank line follows the label line (or its folded list). One prose line
comes next, and a `- ` list directly under it folds too. The list takes dash items only. An
ordered list there stays unparseable.

The prose and its list join the value of the label just above, as `; <prose>: <items>`. The prose
drops a trailing colon first, so `Why: x`, a blank line, `Design settled:`, and `- a` read
`x; Design settled: a`. A plain prose line starts with no whitespace (a nonbreaking or
ideographic space counts), `*`, `_`, a backtick, `>`, or `#`. It is no list, and it holds no report
label name or `Verdict` before any run of marks, whitespace, and a colon. A
whole-line bold heading is the one `*` exception. `**Reviewer notes.**` above `- a`
reads `**Reviewer notes.**: a`.

A report label name or `Verdict` in the line still blocks the fold, with any run of marks, optional
whitespace, and a colon. A `**bold** note` line with trailing text is no heading. A `*` line, a decorated or malformed label, and a `Verdict` line never introduce the list.

A paragraph holds a bold lead and more prose on the same line. With its own dash list between two
labels it makes the block unparseable: put the paragraph and its list under one label.

Put quoted or multi-paragraph text before the closing block, not inside it, and refer to it from one
label with a short line. The label keeps the short result that the parent reads. A quoted paragraph
alone is dropped from the block, and a dash list directly under a quoted prose line makes the block
unparseable.

A column-0 label line whose name and colon sit inside `**...**` is that label, for example
`**Blockers:** none`. Only the six report labels gain this form, so `**Rule:**`
stays text. `**Blockers**:` with the colon outside the bold still makes the block unparseable.
A report label of any shape inside a fenced code block stays text and supplies no value.

A column-0 line that holds only `**Label**`, with no colon and no other text, is that label too. The lines under it supply its value as they do for the plain form.

When no `Conclusion:` label exists, the non-blank plain prose line directly before the first known
report label outside a fence becomes `Conclusion`. Earlier prose stays out of the report. A block with no known
label, or with no such prose line, stays unparseable. A duplicate bold label keeps the
last-occurrence-wins rule.

A bold-lead narration paragraph directly above the first label supplies no conclusion line. The
nearest plain prose line above that narration becomes `Conclusion` instead. All
narration lines above the block stay out of the report.

A lone required label line or a lone `Verdict:` line directly above `Conclusion:`, with only blank
lines between, also joins the block. So `**Blockers:** none` in its own paragraph before
`Conclusion:` still parses. That label must appear once in the response outside a fence. A label in
earlier prose, in a blockquote, or in a fenced code block stays out and neither starts nor extends
the block. A label repeated inside the block keeps its last occurrence. A `Verdict:` line inside the
block still governs over one above it.

A `Verdict:` line inside a fenced code block supplies no verdict. A response whose only `Verdict:`
line sits in a fence has none.

A report that parses only because bold labels were normalized fails closed into `raw` when its
OpenCode response has more than one unidentified part. The report is null in that case. A
single-part response, and every response with only plain labels, keeps its result.

A `- ` item or sub-item that opens with a bold report label name, for example
`- **Notes:** ran`, is item text when it sits inside a run that folds under a label. The same line outside such a run, and any other decorated label,
makes the block unparseable. A prose line directly after the label with no blank line,
a blank line between the prose and its list, a second prose line before the list, prose after
the reviewer `Verdict:` line, and a later repeat of the label stay unparseable.

Any other list in the closing block makes the block unparseable, so the list surfaces
through `raw` instead of being dropped. Examples are bullets after the reviewer `Verdict:` line,
a list outside any label, and a bullet with no space after the marker (`-item`, `*item`). A
separator other than one space (a tab, a nonbreaking space, two spaces) also fails, even under
an empty label. A `*` or `+` bullet, an `N)` item, and an ordered item under a plain prose line
fail too. An indented bullet that is not one nested level (no parent item, a second level,
another indent width) fails as well. A bold heading line that groups a `- ` list
outside the fold rule above fails too.

A child that mirrors the parent prompt's ordered list still puts the list under a label. An indented
label or a decorated label does the same. A label occurrence that a later repeat shadows drops a
list that the repeat shadows. A non-list line, for example a closing sentence, does not make the
block unparseable.

A `*` line is not always a
list, and one shape is the case that matters here: a `*` line whose closing
`*` a letter precedes, where the character right after the close is not a word
character or `*`, and where nothing glued from that character on is a letter
or an ASCII digit, for example `*file*` or `*use a* b`. Such a line is
dropped without `raw` under any label, and every matching line in the block
drops the same way, so the block still parses with the text gone.

A `*` line that is not the dropped shape above either is a list and blanks the block, for example
`*item`, `* item`, or `*file*.mjs`, or is not a list and drops as prose, for example `**bold** note`.

A table pair is a line with a `|` and a delimiter row directly below it. A Markdown table in the block makes it unparseable: put tabular data in `- ` items, one row per item.

## Report text outside the block

A parsed worker or reviewer report can hold a label that points at response text outside the closing block. One example is `Why: the inference above`. The runtime adds `reportOutsideBlockLabels`, which names each such label and holds no response text, for example `["Why"]`. A turn with no match carries no field. The report stays in the envelope unchanged, and the step stays charged.

Nothing outside the block exists, so a response with empty or whitespace-only text before the block carries no field.

Dispatch one worker turn that asks for the named result inside the closing block. On a reviewer envelope with the field, dispatch one reviewer turn for that named result inside the block.

The parent dispatches no restatement turn when the pointer names the content of another label of the same report that holds the result.

The detection is a heuristic over a small pattern list, anchored to a pointer to earlier response text. It reads a noun phrase whose `above` ends it, a verb before `above`, or a reference to the closing block. A word after `above`, such as `above target` or `above the limit`, reads as a comparison and stays out. A value that names a report label stays inside the block, for example `Why: as shown above in Conclusion`. A pointer that the list misses stays undetected.

One documented worker exception returns no label. Exactly one label points outside the block, and the response text before the block holds quoted text or at least two paragraphs. Quoted text is a blockquote line or a fenced code block. A reviewer turn has no exception, because its prompt bars every reference to text outside the block.

## Report values copied from the init task

A child can copy the `Init task:` label lines as plain lines at column 0. The parser cannot tell that shape from a valid block, so the report holds task values. The runtime compares each parsed report value with the value of the same label in the init task. A report value equal to an init task value of the same label adds `reportCopiedTaskLabels`. The field names each copied label, holds no response text, and gives `["Conclusion"]` as an example. A turn with no match carries no field.

Dispatch one turn of the same role that asks for the copied result, restated inside the closing block. The task supplies no comparison value for a line inside a fence, an empty value, or a value of `none` or `n/a`. A correct report can hold `none`, so the field leaves it out. The comparison reads the same label only, and a value under another label stays out. A task `Verdict:` line supplies no comparison, because `accept` is a normal reviewer answer. The field is a heuristic: an exact match costs one restatement turn.
