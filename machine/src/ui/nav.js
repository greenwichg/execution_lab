// Mark the current section in the top navigation.
export function setNav(hash) {
  document.querySelectorAll('.topnav a').forEach((a) => {
    if (hash && a.getAttribute('href') === hash) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
