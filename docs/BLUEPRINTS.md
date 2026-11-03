# Blueprints: build with CSS or XML

Blocks are great for everybody. If you'd rather *describe* a building, write a blueprint: a short text file of shapes that the world compiles into blocks. It's readable, diff-able, remixable, and easy for an AI to write.

> "CSS-style" means CSS **syntax** (rules, properties, `var()`, comments). It isn't browser CSS, and nothing you write is ever run as code. It's compiled by a bounded, deterministic compiler.

Use it three ways:

1. **In the browser:** Build → **Code**. Pick an example or paste text, press **Preview in my plot**, then **Submit**. Your source is what gets submitted.
2. **As a file:** commit `plots/<your-github-username>.css` (or `.xml`) in a pull request.
3. **With AI:** press **Copy AI prompt**, paste it into any chat AI, add your idea, and paste the reply into the Code panel.

You keep exactly one plot file. To switch format, add the new file and delete the old one in the same PR (the editor does this for you).

## CSS-style

```css
:root {
  --title: Hilltop Castle;            /* shown in the world */
  --description: Four towers and a keep.;
  --wall: stone_bricks;               /* reusable materials */
}
.curtain-wall { shape: walls; x: 4; y: 1; z: 4; width: 24; height: 7; depth: 24; block: var(--wall); }
.gate         { shape: box;   x: 14; y: 1; z: 4; width: 4; height: 5; depth: 1; block: air; }   /* air carves */
.tower        { shape: cylinder; x: 2; y: 1; z: 2; width: 7; height: 12; depth: 7; block: var(--wall);
                repeat-x: 2; gap-x: 15; repeat-z: 2; gap-z: 15; }                               /* 4 copies */
```

Each rule is one shape. Rules paint in order, so later rules overwrite earlier ones. Selector names are just labels for you.

## XML

```xml
<plot title="Glass Needle" description="A 48-floor tower.">
  <let name="pane" value="tinted_glass"/>
  <group x="10" y="1" z="10">
    <shell x="0" y="0" z="0" w="12" h="48" d="12" block="$pane"/>
    <box x="0" y="0" z="0" w="12" h="1" d="12" block="iron_block" repeat-y="12" gap-y="3"/>
  </group>
</plot>
```

`<let>` defines `$variables`, `<group>` offsets everything inside it (nest up to 5 deep), and shapes are elements.

## Reference

| Property (CSS) / attribute (XML) | Meaning | Default |
| --- | --- | --- |
| `shape` (CSS) / element name (XML) | `box` solid · `shell` all six faces · `walls` four sides, open top and bottom · `pyramid` shrinks one block per layer · `cylinder` · `sphere` · `dome` (top half) | `box` |
| `x` `y` `z` | position of the shape's lowest corner, 0-31 / 0-63 / 0-31 (negative values are clipped) | 0 |
| `width` `height` `depth` (`w` `h` `d`) | size in blocks, 1-256 | 1 |
| `block` | any block from `data/blocks.json`, or `air` to carve | required |
| `repeat-x/y/z` (`repeat` = x) | number of copies, 1-1000 | 1 |
| `gap-x/y/z` (`gap` = x) | empty blocks between copies | 0 |
| `var(--name)` / `$name` | reuse a value declared in `:root` / `<let>` | |

The plot is 32 wide, 64 tall and 32 deep. Anything outside is cut off.

**Limits:** 40,000 characters of source, 2,000 shapes, 20,000 repeated copies, 30,000 resulting blocks. Errors name the line (CSS) or element (XML).

## Tips for AI prompts

Describe the style, size and landmarks ("a leaning Gothic cathedral with a glowing rose window"), and ask for **repeat/gap** instead of copy-pasted rules. If the compiler reports an error, paste it back to the AI and ask it to fix the blueprint.

## Examples

See [`examples/`](../examples): `castle.css`, `cottage.css`, `needle.xml`, `pagoda.xml`.
