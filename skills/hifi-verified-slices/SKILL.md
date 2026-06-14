---
name: hifi-verified-slices
description: Read this BEFORE using the `hifi` tool on a hard or large engineering task (non-trivial code, a tricky algorithm, a system design, an incident diagnosis). hifi verifies ONE self-contained artifact by running it; this explains how to extract the verifiable pieces of your work and delegate each as one hifi run, instead of one-shotting a hard piece yourself or handing hifi a whole feature, scaffold, or multi-file build.
---

# Verified slices: getting real value from `hifi`

`hifi` is a **verification engine**, not a code generator - you can already
generate code. For ONE self-contained artifact it generates several diverse
candidates, **executes** each candidate's self-test in a sandbox, has an
independent judge pick the winner by what actually ran, and audits the claims. It
returns a single artifact *observed to work*, plus apply steps.

That value exists only for the right unit of work. Use it deliberately.

## What hifi verifies: a single testable artifact

The sweet spot is ONE self-contained piece expressible as **one code block plus
one runnable self-test**:
- a deterministic algorithm or pure function (noise, hashing, parsing, layout);
- a single module with a clear contract you can assert in a test;
- a contained change a build or unit test can prove correct.

If you can write "here is the function, and here is a test that passes exactly
when it is correct," it is a perfect hifi task.

## What hifi is NOT for: glue, scaffolds, visuals

Do NOT hand hifi:
- a whole feature or a multi-file scaffold - it produces ONE artifact, not a
  codebase;
- wiring / glue / boilerplate with no single runnable check;
- anything whose only real check is visual or needs a browser / full integration
  the sandbox cannot run (rendering, materials, shadows, UI look-and-feel).

You build those yourself. hifi verifies the hard, testable atoms inside them.

## The method: extract atoms, delegate them, build the rest

1. Separate the **verifiable atoms** (logic with a runnable check) from the
   **glue** (scaffolding, wiring, UI, visuals).
2. Build the glue yourself.
3. For each atom, run ONE hifi call: state the contract and what a passing
   self-test asserts. Apply the verified result.
4. Integrate the verified atoms into your glue.

This is "portioned hifi research": a sequence of small verified investigations,
each returning code proven to work - not one giant request.

## If hifi returns a roadmap

It judged your task too big to verify as one artifact - you handed it glue or
several features. Do NOT re-send a whole milestone: you will just get another
roadmap (that recursion wastes runs). Instead, build the milestone's glue
yourself, find the ONE hard separately-testable atom inside it, and delegate THAT
alone.

## Don't bail, don't dump

- Don't skip hifi on the atoms that genuinely need verification just because you
  feel confident - that overconfidence is what it exists to catch.
- Don't dump a monolith because slicing feels like work - extracting the atoms IS
  the work that makes verification possible, and it is quick.

## Worked example

Task: *"Build an MVP 3D voxel factory game: seeded terrain, voxel rendering,
buildings, factory mechanics, nice visuals."*

Build yourself (glue / visual - no single runnable check):
- the web scaffold (index.html, renderer, camera, OrbitControls, render loop);
- materials, lighting, shadows, tonemapping, post-processing;
- the UI (seed input, factory stats).

Delegate to hifi (each ONE artifact + a self-test that proves it):
- **seeded noise** - self-test: same seed => identical output (determinism);
- **terrain column generator** - self-test: block-layering rules + a seed
  signature that must not change;
- **greedy mesher** - self-test: known chunk => exact quad counts (solid -> 2,
  cross-chunk -> 5, isolated -> 6);
- **per-vertex ambient occlusion as a pure function** - self-test: occlusion
  values for known neighbour configurations.

Four pieces of logic verified by execution, assembled into the game you built
around them. That is where hifi earns its cost.
