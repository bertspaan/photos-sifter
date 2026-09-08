<script lang="ts">
  import { onMount } from 'svelte'
  import { Moon, Sun } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'

  let night = $state(true)
  onMount(() => {
    night = document.documentElement.classList.contains('dark')
  })

  function toggle() {
    night = !night
    document.documentElement.classList.toggle('dark', night)
    try {
      localStorage.setItem('photos-sifter-theme', night ? 'dark' : 'light')
    } catch {
      // The switch still works when browser storage is unavailable.
    }
  }
</script>

<Button
  variant="ghost"
  size="icon"
  role="switch"
  aria-label="Night mode"
  aria-checked={night}
  title={night ? 'Switch to day mode' : 'Switch to night mode'}
  onclick={toggle}
>
  {#if night}<Moon size={18} />{:else}<Sun size={18} />{/if}
</Button>
