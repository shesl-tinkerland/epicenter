<script lang="ts">
	// Single source of the macOS Accessibility remove/re-add instructions: a
	// screen recording plus the written steps, embedded in the global
	// `MacosAccessibilityGuideDialog`. Kept as one component so any surface can
	// embed the same instructions instead of restating them.
	//
	// The video streams from the GitHub release `_assets` rather than shipping in
	// the app: keeping a multi-MB binary out of the bundle (and out of git) is
	// worth more than the offline demo, because the WRITTEN STEPS below are the
	// real source of truth and render with no network. The video is enhancement
	// only; if it can't load, the steps still carry the user through.
	const GUIDE_VIDEO_URL =
		'https://github.com/EpicenterHQ/epicenter/releases/download/_assets/macos_enable_accessibility.mp4';
</script>

<div class="flex flex-col items-center gap-2">
	<video
		class="max-w-md rounded-lg border"
		src={GUIDE_VIDEO_URL}
		aria-label="macOS Accessibility walkthrough"
		loop
		controls
		muted
		playsinline
	>
		<p class="text-muted-foreground text-sm">
			Video guide not available. Please follow the written instructions below.
		</p>
	</video>
	<ol
		class="text-muted-foreground list-inside list-decimal space-y-1 text-sm leading-7"
	>
		<li>
			Go to
			<span class="text-primary font-semibold tracking-tight">
				System Settings > Privacy & Security > Accessibility
			</span>.
		</li>
		<li>
			Click on
			<span class="text-primary font-semibold tracking-tight">Whispering</span>
			and remove it using the minus icon (-).
		</li>
		<li>
			Re-add Whispering by pressing the plus icon (+) and selecting
			<span class="text-primary font-semibold tracking-tight"
				>Whispering.app</span
			>.
		</li>
	</ol>
</div>
