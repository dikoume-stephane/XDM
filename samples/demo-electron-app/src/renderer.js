document.querySelector('h1').addEventListener('click', async () => {
  const p = await window.vault.read();
  document.title = p ? 'opened ' + p : 'cancelled';
});
