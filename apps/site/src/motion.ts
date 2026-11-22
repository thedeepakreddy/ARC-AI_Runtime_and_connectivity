import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { FLOW_EVENT } from './Flow';
import type { Sky } from './scene';

gsap.registerPlugin(ScrollTrigger);

// The page's scroll choreography. Markup opts in with data attributes:
//   data-shot="n"   the sky's camera moves to shot n while this section is in view
//   data-split      its letters lift away and scatter as the hero scrolls off
//   data-rise       rises in once the opening has finished
//   data-reveal     rises into place as it arrives
//   data-fact       stat tiles drop in, and their [data-count] numbers count up
//   data-row        table rows slide in one after another
//   data-marquee    a row of providers that drifts, faster as you scroll, and turns with you
//   data-flow       How ARC works: pinned on wide screens while the scroll walks its seven stages
export function initMotion(sky: Sky | null): () => void {
  const ticks: Array<(t: number, dt: number) => void> = [];
  const ctx = gsap.context(() => {
    let speed = 0;
    ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: (self) => {
        speed = self.getVelocity();
        sky?.setVelocity(speed);
      },
    });

    // The sky's camera follows the sections.
    gsap.utils.toArray<HTMLElement>('[data-shot]').forEach((el) => {
      const n = Number(el.dataset.shot);
      ScrollTrigger.create({
        trigger: el,
        start: 'top 55%',
        end: 'bottom 45%',
        onToggle: (s) => {
          if (s.isActive) sky?.setShot(n);
        },
      });
    });

    // The hero: rises in after the opening; its headline scatters as it scrolls away.
    const rise = () => {
      gsap.fromTo(
        '[data-rise], [data-split] .char',
        { y: 40, opacity: 0 },
        { y: 0, opacity: 1, duration: 1.1, ease: 'power3.out', stagger: 0.012 },
      );
    };
    if (document.documentElement.classList.contains('intro-on')) {
      const mo = new MutationObserver(() => {
        if (!document.documentElement.classList.contains('intro-on')) {
          mo.disconnect();
          rise();
        }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    } else rise();
    const hero = document.querySelector('.hero');
    if (hero) {
      const chars = gsap.utils.toArray<HTMLElement>('[data-split] .char');
      gsap
        .timeline({
          scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom 20%', scrub: 0.6 },
        })
        .to(
          chars,
          {
            yPercent: () => gsap.utils.random(-260, -60),
            xPercent: () => gsap.utils.random(-60, 60),
            rotate: () => gsap.utils.random(-30, 30),
            opacity: 0,
            ease: 'power2.in',
            stagger: { each: 0.01, from: 'start' },
          },
          0,
        )
        .to('[data-rise]', { y: -80, opacity: 0, ease: 'none', stagger: 0.05 }, 0);
    }

    // Arrivals.
    gsap.set('[data-reveal]', { y: 50, opacity: 0 });
    ScrollTrigger.batch('[data-reveal]', {
      start: 'top 90%',
      onEnter: (b) =>
        gsap.to(b, {
          y: 0,
          opacity: 1,
          duration: 1,
          ease: 'power3.out',
          stagger: 0.08,
          overwrite: true,
        }),
    });
    gsap.utils.toArray<HTMLElement>('[data-fact]').forEach((el, i) => {
      gsap.fromTo(
        el,
        { y: 60, opacity: 0, rotateX: -35, transformPerspective: 900, transformOrigin: '50% 0%' },
        {
          y: 0,
          opacity: 1,
          rotateX: 0,
          duration: 1.1,
          ease: 'power3.out',
          delay: i * 0.08,
          scrollTrigger: { trigger: el, start: 'top 92%' },
        },
      );
      el.querySelectorAll<HTMLElement>('[data-count]').forEach((n) => {
        const to = Number(n.dataset.count);
        const o = { v: 0 };
        gsap.to(o, {
          v: to,
          duration: 1.6,
          ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 92%' },
          onUpdate: () => {
            n.textContent = String(Math.round(o.v));
          },
        });
      });
    });
    gsap.utils.toArray<HTMLElement>('[data-row]').forEach((row, i) => {
      gsap.fromTo(
        row,
        { x: -40, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 0.8,
          ease: 'power3.out',
          delay: (i % 8) * 0.06,
          scrollTrigger: { trigger: row, start: 'top 94%' },
        },
      );
    });

    // Provider rows drift, speed up with scrolling, and turn with its direction.
    gsap.utils.toArray<HTMLElement>('[data-marquee]').forEach((row) => {
      const dir0 = Number(row.dataset.marquee) || 1;
      const track = row.firstElementChild as HTMLElement | null;
      if (!track) return;
      let x = 0,
        dir = dir0;
      const tick = (_t: number, dtMs: number) => {
        if (speed) dir = (speed > 0 ? 1 : -1) * dir0;
        const half = track.scrollWidth / 2 || 1;
        x -= (dtMs / 1000) * (40 + Math.min(900, Math.abs(speed) * 0.3)) * dir;
        x = (((x % half) + half) % half) - half;
        gsap.set(track, { x });
      };
      gsap.ticker.add(tick);
      ticks.push(tick);
    });

    // How ARC works: pinned while the scroll walks the seven stages (wide screens).
    const mm = gsap.matchMedia();
    mm.add('(min-width: 961px)', () => {
      const sec = document.querySelector<HTMLElement>('[data-flow]');
      if (!sec) return;
      let last = -1;
      ScrollTrigger.create({
        trigger: sec,
        start: 'top top',
        end: '+=3600',
        pin: true,
        pinSpacing: true,
        anticipatePin: 1,
        onUpdate: (s) => {
          const stage = Math.min(6, Math.floor(s.progress * 7));
          if (stage !== last) {
            last = stage;
            window.dispatchEvent(new CustomEvent(FLOW_EVENT, { detail: stage }));
          }
        },
      });
    });
  });
  const t = setTimeout(() => ScrollTrigger.refresh(), 500);
  return () => {
    clearTimeout(t);
    ticks.forEach((fn) => gsap.ticker.remove(fn));
    ctx.revert();
  };
}
