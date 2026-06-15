<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { SettingSwitch } from '$lib/components/settings';
	import { os } from '#platform/os';
	import { tauri } from '#platform/tauri';
</script>

<svelte:head> <title>Sound Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Sound</Field.Legend>
	<Field.Description>
		Configure your Whispering sound preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		{#if tauri && os.isApple}
			<Field.Set>
				<Field.Legend variant="label">Media</Field.Legend>
				<Field.Description>
					Pause Music or Spotify while Whispering records.
				</Field.Description>
				<Field.Group>
					<SettingSwitch
						key="sound.pauseMediaDuringRecording"
						label="Pause media while recording"
					/>
				</Field.Group>
			</Field.Set>

			<Field.Separator />
		{/if}

		<Field.Set>
			<Field.Legend variant="label">Manual Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for manual recording events.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="sound.manualStart"
					label="Play sound when starting manual recording"
				/>
				<SettingSwitch
					key="sound.manualStop"
					label="Play sound when stopping manual recording"
				/>
				<SettingSwitch
					key="sound.manualCancel"
					label="Play sound when canceling manual recording"
				/>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">VAD Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for voice-activated detection events.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="sound.vadStart"
					label="Play sound when starting VAD recording session"
				/>
				<SettingSwitch
					key="sound.vadCapture"
					label="Play sound on VAD capture"
				/>
				<SettingSwitch
					key="sound.vadStop"
					label="Play sound when stopping VAD recording session"
				/>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Completion Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for transcription and transformation completion.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="sound.transcriptionComplete"
					label="Play sound after transcription"
				/>
				<SettingSwitch
					key="sound.transformationComplete"
					label="Play sound after transformation"
				/>
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>
