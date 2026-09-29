import "../src/style.css";
import SiteMotion from '../src/site-motion';
export const metadata = { metadataBase:new URL('https://nuggetsmp.online'), title: "Nugget SMP — Survival, trading & PvP", description: "Join play.nuggetsmp.online:25590. Link your Minecraft account, check server status and get Nugget+.", icons: { icon: "/nugget.png" } };
export default function Layout({children}) { return <html lang="en" suppressHydrationWarning><body><SiteMotion/>{children}</body></html>; }
