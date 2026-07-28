const frame = document.getElementById('abaFrame');
const loading = document.getElementById('abaLoading');

frame.addEventListener('load', () => {
  loading.classList.add('is-hidden');
});
