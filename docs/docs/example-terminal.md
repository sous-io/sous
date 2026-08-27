# Terminal demos

?> This is an example page. It shows the animated terminal component; it will be replaced by
real reference content.

A ` ```term ` fence renders as a small terminal window that types its commands and prints
their output, starting the first time it scrolls into view:

```term
$ npm install -g @sous-io/sous
>> 100%
$ xcv --version
@sous-io/sous
```

## Authoring

Write a fenced block with the language tag `term`. Inside it, each line is one of:

| Prefix | Meaning |
|--------|---------|
| `$ ` | a command, typed character by character |
| `// ` | a subtle comment line |
| `>> ` | an animated progress bar |
| anything else | printed output |
| blank line | a spacer |

So this block (shown as an indented code block so it renders literally; write it as a normal
unindented fence):

    ```term
    $ xcv build
    // compile, then prune
    compiled 4 targets
    ```

produces a demo like the ones on this page. The animation engine is
[termynal](https://github.com/termynal/termynal.py) (MIT), loaded from a pinned CDN URL; the
fence conversion and the play-on-scroll behavior are site-owned glue in `docs/js/term-demos.js`.

## Plays on scroll

This second demo sits far enough down the page that it only starts once you reach it. Each
demo also gets `fast forward` and `restart` controls.

```term
$ xcv build --watch
// watching for template and config changes
building "My Project"...
compiled 4 targets, pruned 0 stale files

// edit a template in another window...
change detected: prompts/root/CLAUDE.md
compiled 1 target
```
