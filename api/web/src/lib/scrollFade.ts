export function attachScrollFade(node: HTMLElement): () => void {
  function update(): void {
    const canLeft = node.scrollLeft > 4;
    const canRight = node.scrollLeft < node.scrollWidth - node.clientWidth - 4;
    node.classList.toggle('scroll-fade-left', canLeft);
    node.classList.toggle('scroll-fade-right', canRight);
  }

  update();
  node.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(node);

  return () => {
    node.removeEventListener('scroll', update);
    ro.disconnect();
  };
}

export function scrollFade(node: HTMLElement): { destroy: () => void } {
  return { destroy: attachScrollFade(node) };
}
