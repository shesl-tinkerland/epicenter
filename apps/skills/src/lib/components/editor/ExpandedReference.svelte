<script lang="ts">
	import { useCacheHandle } from '@epicenter/svelte';
	import { skills } from '$lib/skills/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();

	const doc = useCacheHandle(skills.referenceDocs, () => id);
</script>

<div class="h-48 border-t">
	<CodeMirrorEditor ytext={doc.current.content.binding} />
</div>
