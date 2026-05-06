<script lang="ts">
	import { useCacheHandle } from '@epicenter/svelte';
	import { skills } from '$lib/skills/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	const doc = useCacheHandle(skills.instructionsDocs, () => skillId);
</script>

<CodeMirrorEditor ytext={doc.current.instructions.binding} />
