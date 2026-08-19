# KITE motion decision

**Status:** Accepted

**Date:** 2026-08-17

The first console direction prohibited all animation. That protected the operator view from
ambient dashboard noise, but it also removed the product's only chance to feel alive and
recognizable in a terminal recording.

Fleet Console now uses one motion system: KITE, an original terminal-native fleet navigator tied
to the selected lane's real state. Its five-line silhouette combines an expressive face, wing-like
signal rails, orbiting lane nodes, and a status core. Running work looks, blinks, and pulses at a
capped four frames per second. Completed work keeps a subtle orbit while awaiting independent
verification; verified work smiles and locks into place. Blocked, failed, and unknown outcomes use
distinct non-celebratory eyes, core, and posture. The compact layout reduces
the same face and core to a recognizable signal sigil rather than introducing a second visual
language.

This is semantic motion, not decoration. Navigation, evidence, and authority remain static. `p`
pauses KITE immediately. Reduced-motion and screen-reader modes are static. The animation loop
exists only while Fleet Console owns the terminal and is removed on every exit path.

The reusable rule is: one named living signature may communicate system state; unrelated ambient
effects, loading theatre, gradients, particle fields, and continuous background motion remain out
of scope.

KITE is intentionally not a copy of another product's mascot. The design uses its own winged
navigator silhouette and cyan signal language; the reusable lesson is recognizability through a
small pixel vocabulary and stateful body language.
