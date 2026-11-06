import { Hero } from "@/components/Hero";
import { Lifecycle } from "@/components/Lifecycle";
import { CreditCeiling } from "@/components/CreditCeiling";
import { Waterfall } from "@/components/Waterfall";
import { Trust } from "@/components/Trust";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <main>
      <Hero />
      <Lifecycle />
      <CreditCeiling />
      <Waterfall />
      <Trust />
      <Footer />
    </main>
  );
}
