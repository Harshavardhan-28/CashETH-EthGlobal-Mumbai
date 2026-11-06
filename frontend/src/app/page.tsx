import { Intro } from "@/components/Intro";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { CreditCeiling } from "@/components/CreditCeiling";
import { Waterfall } from "@/components/Waterfall";
import { Principles } from "@/components/Principles";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <main>
      <Intro />
      <Hero />
      <HowItWorks />
      <CreditCeiling />
      <Waterfall />
      <Principles />
      <Footer />
    </main>
  );
}
