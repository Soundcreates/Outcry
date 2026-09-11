import "./landing.css";
import ScrollProgress from "./ScrollProgress";
import Hero from "./Hero";
import ProblemSection from "./ProblemSection";
import SolutionSection from "./SolutionSection";
import FeaturesGrid from "./FeaturesGrid";
import MagicBlockSpotlight from "./MagicBlockSpotlight";
import ArchitectureDiagram from "./ArchitectureDiagram";
import WorldsSection from "./WorldsSection";
import FinalCta from "./FinalCta";

export default function LandingPage() {
  return (
    <main className="landing">
      <ScrollProgress />
      <Hero />
      <ProblemSection />
      <SolutionSection />
      <FeaturesGrid />
      <MagicBlockSpotlight />
      <ArchitectureDiagram />
      <WorldsSection />
      <FinalCta />
    </main>
  );
}
