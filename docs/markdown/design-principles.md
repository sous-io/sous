# Design Principles

These principles govern every feature sous ships. They are constraints on design, not
aspirations; when a proposal violates one, the proposal changes.

## 1. Augment, don't compete

When a coding tool can do something natively, do it natively; sous exists for what the tool
cannot do. Sous never wraps, replaces, or re-implements a capability an agent harness already
provides well.

*Example: sous compiles `CLAUDE.md` and skill files because no harness composes them from
shared, templated sources; it does not try to replace how the harness loads them.*

## 2. Fill the collective gaps

Sous actively tries to avoid competing with any tool, and especially with any class of tools.
Instead it fills the gaps that most or all tools either cannot or will not fill, because those
problems span every provider at once.

*Example: keeping one instruction source current across Claude, Codex, and whatever comes next
is nobody's product; it is sous's whole job.*

## 3. Be a tool, not a framework

Sous avoids forcing opinions; that is different from having none. Beyond the few core skills
that teach agents how to work with sous itself, every built-in is opt-in only, and even the
core is opt-out-able.

*Example: the core skills arrive by default because agents need them to avoid editing
generated files, but a single explicit setting removes them entirely.*

## 4. Be easy to enter

Sous copies plain files just as readily as it renders templates, so adopting it does not
require converting anything. Existing marketplaces and installers keep working, pointed at a
sous-managed directory.

*Example: drop an existing skill directory into a sous target unchanged; it compiles verbatim
on the next build.*

## 5. Be easy to exit

Leaving sous must never cost more than a commit. The generated output is complete and ordinary;
commit it and delete `.sous`, and the project keeps working exactly as it did.

*Example: every file sous writes is a normal file in its final location; nothing references
sous at runtime.*

## 6. Maximum user control

Everything gets an escape hatch, within practicality. The happy path stays maximally simple;
the escape hatches are advanced usage and may require the docs, but they must exist and they
still get thoughtful ergonomics. Projects control everything granularly, and an individual
user can override every project decision through their own configuration layers.

*Example: subscribing to a recipe is one line and pulls in everything the recipe provides;
excluding one skill from that subscription may take a documented setting, but the setting is
there.*
