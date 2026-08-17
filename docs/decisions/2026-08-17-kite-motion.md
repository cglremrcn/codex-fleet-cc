# KITE motion decision

**Status:** Accepted

**Date:** 2026-08-17

The first console direction prohibited all animation. That protected the operator view from
ambient dashboard noise, but it also removed the product's only chance to feel alive and
recognizable in a terminal recording.

Fleet Console now uses one motion system: KITE, a small formation tied to the selected lane's real
state. Active lanes can move at a capped four frames per second. Verified work locks into place.
Blocked, failed, and unknown outcomes use distinct postures instead of celebratory motion. The
compact layout reduces the same formation to a signal sigil rather than introducing a second
visual language.

This is semantic motion, not decoration. Navigation, evidence, and authority remain static. `p`
pauses KITE immediately. Reduced-motion and screen-reader modes are static. The animation loop
exists only while Fleet Console owns the terminal and is removed on every exit path.

The reusable rule is: one named living signature may communicate system state; unrelated ambient
effects, loading theatre, gradients, particle fields, and continuous background motion remain out
of scope.
