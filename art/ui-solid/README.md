# ui-solid — not art

One cell of solid opaque white.

Every bar, panel fill and fade the game draws is a plain rectangle, and the renderer only knows how to
draw a piece of the sheet — so a plain rectangle is this cell stretched and tinted. It has to live on the
same sheet as everything else, because the whole point of one sheet is that drawing a layer never has to
swap pictures halfway through.

It is generated, not drawn, and it is the only cell in the whole art folder that is. Nobody should
redraw it: if it stops being solid white, every health bar in the game picks up its pattern.
