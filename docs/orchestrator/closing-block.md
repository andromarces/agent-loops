# Closing block list rules

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a child report holds a list, or when `report` is null and `raw` carries the response.

Each value of `report.notes` and `report.deferred` is one line, the label plain at column 0. A `- `
list or an ordered `N. ` list (a `-` or a number and a period at column 0, exactly one space U+0020, then the item) that directly follows a report
label line is that label's value, or joins the value that line already holds:
the markers drop and the items join into one line with `; ` (issues #846, #879,
and #915). A list under `Blockers: none` therefore reads `none; <item>`, never
`none`. The reviewer `Verdict:` line is no report label, so a list after it
stays unparseable.

One nesting level folds too:
a sub-item line (spaces U+0020 up to the column where the parent item text starts, so two after `- ` and three after `1. `, then a `-`, one space U+0020, then the
item) directly after a `- ` or `N. ` item joins into that item with `, `, and several
consecutive sub-items under one parent all fold into it, so the lines `- a`,
two spaces then `- b`, and two spaces then `- c` read `a, b, c` (issues #870 and #915). A sub-item under `1. a` takes three spaces, so `1. a` and `   - b` read `a, b`.

An indented non-list line (ASCII spaces or tabs, then text) directly after an item or its sub-items folds into that item with a space, like a Markdown lazy continuation, so `- a`, `  - b`, and `  more` read `a, b more` (issue #1082). An indented line never folds when it reads as a label line: after NFKC normalization, it skips every leading character that is no letter or digit and one optional number, then holds a report label name or `Verdict`, any case, optional whitespace, and a character that is no letter, digit, or whitespace. Any colon variant (`:`, `：`, `∶`), any other separator, and any count or kind of markup around the name then refuse (`**Verdict:** x`, `Verdict***: x`, `1 Verdict: x`, and `> Verdict： x` after two spaces are examples), so the items after it stay unparseable lists. A label word that a letter follows (`Notes about x`), or whitespace and then a letter (`Why this matters:`), is prose and folds. An indented list line there is no continuation and stays unparseable.

The run ends at the first line that is not a `- ` or `N. ` item, a sub-item of the item above it, or an indented continuation line of that item, so a blank line or unindented prose between
the label and the list breaks it. Two shapes with a blank line fold anyway.

The first shape is one blank line after the label line, then a `- ` list directly under that blank
line. The items join the label value with `; `, so `Why: x`, a blank line, and `- a` read `x; a`. An
empty `Notes:` reads `a` (issue #1348). The list takes dash items only. Two blank lines under the
label before the list, and an ordered list there, stay unparseable.

The second shape has prose. A blank line follows the label line (or its folded list). One prose line
comes next, and a `- ` list directly under it folds too. The list takes dash items only, because an
ordered list there stays unparseable.

The prose and its list join the value of the label just above, as `; <prose>: <items>`. The prose
drops a trailing colon first, so `Why: x`, a blank line, `Design settled:`, and `- a` read
`x; Design settled: a` (issue #898). A plain prose line starts with no whitespace (a nonbreaking or
ideographic space counts), `*`, `_`, a backtick, `>`, or `#`. It is no list, and it holds no report
label name or `Verdict` before any run of marks, whitespace, and a colon. A
whole-line bold heading is the one `*` exception (issue #1367). `**Reviewer notes.**` above `- a`
reads `**Reviewer notes.**: a`.

A report label name or `Verdict` in the line still blocks the fold, with any run of marks, optional
whitespace, and a colon. A `**bold** note` line with trailing text is no heading. A `*` line (issue
#275), a decorated or malformed label, and a `Verdict` line never introduce the list.

A paragraph holds a bold lead and more prose on the same line. With its own dash list between two
labels it makes the block unparseable: put the paragraph and its list under one label (issue #1386).

A column-0 label line whose name and colon sit inside `**...**` is that label, for example
`**Blockers:** none` (issue #1483). Only the six report labels gain this form, so `**Rule:**`
stays text. `**Blockers**:` with the colon outside the bold still makes the block unparseable.
A bold label inside a fenced code block stays text.

When no `Conclusion:` label exists, the non-blank plain prose line directly before the first known
report label becomes `Conclusion`. Earlier prose stays out of the report. A block with no known
label, or with no such prose line, stays unparseable. A duplicate bold label keeps the
last-occurrence-wins rule.

A `- ` item or sub-item that opens with a bold report label name, for example
`- **Notes:** ran`, is item text when it sits inside a run that folds under a label
(issue #1006). The same line outside such a run, and any other decorated label,
makes the block unparseable. A prose line directly after the label with no blank line,
a blank line between the prose and its list, a second prose line before the list, prose after
the reviewer `Verdict:` line, and a later repeat of the label stay unparseable.

Any other list in the closing block makes the block unparseable, so the list surfaces
through `raw` instead of being dropped. Examples are bullets after the reviewer `Verdict:` line,
a list outside any label, and a bullet with no space after the marker (`-item`, `*item`). A
separator other than one space (a tab, a nonbreaking space, two spaces) also fails, even under
an empty label. A `*` or `+` bullet, an `N)` item, and an ordered item under a blank line or
prose fail too. An indented bullet that is not one nested level (no parent item, a second level,
another indent width or marker) fails as well. A bold heading line that groups a `- ` list
outside the fold rule above fails too.

The parent prompt can format its own blockers as an ordered list. A child that mirrors that shape
still puts the list under a label. An indented label or a decorated label
does the same. This covers a label occurrence that a later repeat shadows, which
also drops a list that the repeat shadows. A non-list line, for example a closing
sentence, does not make the block unparseable.

A `*` line is not always a
list, and one shape is the case that matters here: a `*` line whose closing
`*` a letter precedes, where the character right after the close is not a word
character or `*`, and where nothing glued from that character on is a letter
or an ASCII digit, for example `*file*` or `*use a* b`. Such a line is
dropped without `raw` under any label, and every matching line in the block
drops the same way, so the block still parses with the text gone (issue #275,
accepted gap).

A child is told to write no block line that starts with `*`. Every other `*`
line either is a list and blanks the block, for example `*item`, `* item`, or
`*file*.mjs`, or is not a list and drops as prose, for example `**bold** note`.

A table pair is a line with a `|` and a delimiter row directly below it. A Markdown table in the block makes it unparseable: put tabular data in `- ` items, one row per item.
