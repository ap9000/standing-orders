# Workspace motion

Uses the user-selected Transitions.dev skill's portable menu dropdown, panel
reveal, sliding tab and accordion recipes, pinned to upstream commit
598d3d6ad89dabb4bdf742fd2e887ca53914a888.

Source: https://github.com/Jakubantalik/transitions.dev/tree/598d3d6ad89dabb4bdf742fd2e887ca53914a888/skills/transitions-dev

Recipe CSS is kept intact in transitions-recipes.ts. Application styling and
native-DOM wiring live in workspace-motion.ts. No runtime dependency added.
No blur, bounce or decorative gradients; existing underline tabs and palette
remain. Reduced-motion settings disable transitions. Controls still work without
JavaScript, and pages with sensitive forms keep their existing composition rules.
Navigation is not intercepted or delayed to finish an animation.

Checked native disclosure/menu keyboard use, Escape, tab arrow keys, rapid
close/reopen, retained draft nodes, dynamic insertion and reduced motion.
Desktop and phone screenshots are recorded with the chat/UI pass.
Cross-document result transitions use progressive browser support; their full
entry/exit was not visually certified across Safari, Windows or physical phones.
