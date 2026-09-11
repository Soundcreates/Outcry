import { useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

type LifecycleItem = {
  title: string;
  body: string;
};

export default function LifecycleScroller({ items }: { items: LifecycleItem[] }) {
  const prefersReducedMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion) return;
      const track = trackRef.current;
      const stage = stageRef.current;
      if (!track || !stage) return;

      const distance = track.scrollWidth - stage.clientWidth;
      if (distance <= 0) return;

      gsap.to(track, {
        x: -distance,
        ease: "none",
        scrollTrigger: {
          trigger: stage,
          start: "center center",
          end: () => `+=${track.scrollWidth - stage.clientWidth}`,
          scrub: 1,
          pin: true,
          invalidateOnRefresh: true,
        },
      });
    },
    { scope: stageRef, dependencies: [prefersReducedMotion] },
  );

  if (prefersReducedMotion) {
    return (
      <div className="landing-grid landing-grid-3">
        {items.map((item, index) => (
          <article className="landing-card landing-card-mono" key={item.title}>
            <span className="landing-mono-index">{String(index + 1).padStart(2, "0")}</span>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="landing-lifecycle-stage" ref={stageRef}>
      <div className="landing-lifecycle-track" ref={trackRef}>
        {items.map((item, index) => (
          <article className="landing-card landing-card-mono landing-lifecycle-card" key={item.title}>
            <span className="landing-mono-index">{String(index + 1).padStart(2, "0")}</span>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
