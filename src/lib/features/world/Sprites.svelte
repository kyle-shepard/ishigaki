<!--
	Every piece of map art, once, as SVG <symbol>s. Rendered once per page; tiles and overlays
	reference them with <use href="#i-name"/>, so 256 tiles cost 256 references and one copy of
	each shape rather than 256 copies of the paths.

	Naming: `i-<key>` where <key> is the `icon` column on terrain_type / building_type. `p-*` are
	private primitives composed by the symbols above them — a rock is drawn once and reused for
	both stone and iron.

	Drawn on a 32×32 viewBox with no background: the tile's `color` shows through, so every shape
	has to contrast against the colour its row carries (see the note in scripts/seed.ts).

	ponytail: hand-authored flat vectors, no sprite pipeline and no asset dependency. Sized for
	the current fixed 32px cell; they scale, but they are not authored for a zoomed-out LOD tier —
	that's the map-client epic's problem, and it will want fewer marks per tile, not these shrunk.
-->
<svg width="0" height="0" aria-hidden="true" focusable="false" style="position: absolute">
	<defs>
		<!-- Origin at the trunk's foot, so a tree is placed by where it stands. -->
		<g id="p-tree">
			<rect x="-1.3" y="-8" width="2.6" height="8" fill="#4a3520" />
			<path d="M0 -12 L7.5 2 H-7.5 Z" fill="#1d5426" />
			<path d="M0 -20 L6 -5 H-6 Z" fill="#16401d" />
			<path d="M0 -26 L4.5 -13 H-4.5 Z" fill="#215d29" />
		</g>
		<!-- Body inherits `fill` from the <use>, so one rock serves every stone-like terrain; the
		     lit facet is a translucent white wash so it works over any of them. -->
		<g id="p-rock">
			<path d="M-8 0 L-5.5 -6.5 L0.5 -9 L6.5 -4 L7.5 0 Z" />
			<path d="M-5.5 -6.5 L0.5 -9 L1.5 -3.5 Z" fill="#fff" fill-opacity=".22" />
		</g>

		<symbol id="i-meadow" viewBox="0 0 32 32">
			<g fill="none" stroke="#7ba84e" stroke-width="1.6" stroke-linecap="round">
				<path d="M8 26v-4M5.5 26l1.6-3.2M10.5 26L8.9 22.8" />
				<path d="M23 15v-3.4M21 15l1.3-2.7M25 15l-1.3-2.7" />
			</g>
		</symbol>

		<symbol id="i-forest" viewBox="0 0 32 32">
			<use href="#p-tree" transform="translate(10,28) scale(.82)" />
			<use href="#p-tree" transform="translate(22,23) scale(.6)" />
			<use href="#p-tree" transform="translate(25,32) scale(.5)" />
		</symbol>

		<symbol id="i-stone" viewBox="0 0 32 32">
			<use href="#p-rock" fill="#71757b" transform="translate(13,25)" />
			<use href="#p-rock" fill="#5d6167" transform="translate(23,14) scale(.6)" />
		</symbol>

		<!-- The same rocks, warmer, plus the ore that makes it a vein rather than an outcrop. -->
		<symbol id="i-iron" viewBox="0 0 32 32">
			<use href="#p-rock" fill="#a5644e" transform="translate(14,25)" />
			<use href="#p-rock" fill="#8d5342" transform="translate(23,13) scale(.55)" />
			<g fill="#33201a">
				<circle cx="11" cy="20" r="1.6" />
				<circle cx="16" cy="22.5" r="1.2" />
				<circle cx="18" cy="18" r="1.4" />
			</g>
		</symbol>

		<symbol id="i-clay" viewBox="0 0 32 32">
			<ellipse cx="16" cy="19" rx="11" ry="7" fill="#b0713a" />
			<ellipse cx="16" cy="20" rx="7" ry="4.2" fill="#8a5426" />
			<g fill="#c98b4d">
				<circle cx="7" cy="12" r="2.4" />
				<circle cx="26" cy="25" r="2" />
			</g>
		</symbol>

		<!-- Back peak first: the near peak has to overlap it, or they read as one flat ridge. -->
		<symbol id="i-mountain" viewBox="0 0 32 32">
			<path d="M15 29 L24 12 L32 29 Z" fill="#5f584f" />
			<path d="M1 29 L12 6 L23 29 Z" fill="#7d746a" />
			<path d="M12 6 L17 16 L13.5 14 L10.5 16.5 L7 15 Z" fill="#eceae5" />
		</symbol>

		<symbol id="i-water" viewBox="0 0 32 32">
			<g fill="none" stroke="#9fcbee" stroke-width="1.7" stroke-linecap="round" opacity=".8">
				<path d="M3 10q3.5-3 7 0t7 0" />
				<path d="M12 19q3.5-3 7 0t7 0" />
				<path d="M2 27q3.5-3 7 0t7 0" />
			</g>
		</symbol>

		<symbol id="i-house" viewBox="0 0 32 32">
			<rect x="6" y="15" width="20" height="13" fill="#e0d0ac" />
			<path d="M16 4 L30 16 H2 Z" fill="#6b3a2a" />
			<path d="M16 7.5 L25.5 15.6 H6.5 Z" fill="#84503a" />
			<rect x="14" y="20" width="6" height="8" fill="#5b3a22" />
			<rect x="8.5" y="18" width="4" height="4" fill="#8ba3b8" />
			<rect x="6" y="27" width="20" height="1.6" fill="#00000022" />
		</symbol>

		<!-- A barn: one long roof, wide doors, no chimney — read as storage, not a dwelling. -->
		<symbol id="i-barn" viewBox="0 0 32 32">
			<rect x="5" y="14" width="22" height="14" fill="#a44a3a" />
			<path d="M16 5 L29 15 H3 Z" fill="#7d3327" />
			<rect x="11" y="18" width="10" height="10" fill="#e6d8bb" />
			<path d="M11 18 L21 28 M21 18 L11 28" stroke="#a44a3a" stroke-width="1.4" />
			<rect x="5" y="27" width="22" height="1.6" fill="#00000022" />
		</symbol>

		<!-- A quarry: cut steps into the rock, and the spoil below. -->
		<symbol id="i-quarry" viewBox="0 0 32 32">
			<path d="M4 26 H28 V21 H22 V16 H16 V11 H6 V26 Z" fill="#9aa0a6" />
			<path d="M6 11 H16 V16 H22 V21 H28" fill="none" stroke="#6f757b" stroke-width="1.6" />
			<circle cx="9" cy="24" r="1.8" fill="#c3c8cc" />
			<circle cx="13.5" cy="25" r="1.2" fill="#c3c8cc" />
			<rect x="4" y="26" width="24" height="1.6" fill="#00000022" />
		</symbol>

		<!-- The wall the project is named for: fitted stone, wider at the base. -->
		<symbol id="i-wall" viewBox="0 0 32 32">
			<path d="M3 28 L7 8 H25 L29 28 Z" fill="#b6bbc0" />
			<g stroke="#7d8489" stroke-width="1.1" fill="none">
				<path d="M6.2 13 H25.8 M5.2 18 H26.8 M4.2 23 H27.8" />
				<path d="M13 8 V13 M19 8 V13 M10 13 V18 M16 13 V18 M22 13 V18 M13 18 V23 M19 18 V23" />
			</g>
			<rect x="3" y="27" width="26" height="1.6" fill="#00000022" />
		</symbol>

		<!-- A school: a hall with a pediment and a bell-cote — reads as a civic building, not a home. -->
		<symbol id="i-school" viewBox="0 0 32 32">
			<rect x="5" y="14" width="22" height="14" fill="#d8c59a" />
			<path d="M4 14 L16 6 L28 14 Z" fill="#5b6b7a" />
			<path d="M15 3 h2 v3 h-2 z" fill="#8a6d3a" />
			<circle cx="16" cy="10.5" r="1.4" fill="#3a2f1c" />
			<g fill="#7d5a2e">
				<rect x="8" y="18" width="4" height="10" />
				<rect x="20" y="18" width="4" height="10" />
			</g>
			<rect x="14" y="20" width="4" height="8" fill="#5b3a22" />
			<rect x="5" y="27" width="22" height="1.6" fill="#00000022" />
		</symbol>

		<!-- A character. Pale outline so it stays legible crossing water, forest, or mountain. -->
		<symbol id="i-pawn" viewBox="0 0 32 32">
			<g stroke="#f2f4f8" stroke-width="1.4">
				<path d="M9.5 25c0-4.6 2.9-7.5 6.5-7.5s6.5 2.9 6.5 7.5z" fill="#22409c" />
				<circle cx="16" cy="12.5" r="4.2" fill="#2d54c8" />
			</g>
		</symbol>
	</defs>
</svg>
