import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { isPortalTarget } from "@/lib/runtime";
import Index from "./pages/Index";
import HowItWorks from "./pages/HowItWorks";
import NotFound from "./pages/NotFound";
import PortalRoot from "./portal/pages/PortalRoot";
import PortalSetup from "./portal/pages/PortalSetup";
import PortalLogin from "./portal/pages/PortalLogin";
import PortalPasswordReset from "./portal/pages/PortalPasswordReset";
import PortalPasswordResetVerify from "./portal/pages/PortalPasswordResetVerify";
import PortalDashboard from "./portal/pages/PortalDashboard";
import PortalLessonPlans from "./portal/pages/PortalLessonPlans";
import PortalCoaching from "./portal/pages/PortalCoaching";
import PortalCoachingAnalytics from "./portal/pages/PortalCoachingAnalytics";
import PortalCoachingDetail from "./portal/pages/PortalCoachingDetail";
import PortalReadingAssessments from "./portal/pages/PortalReadingAssessments";
import PortalReadingAssessmentDetail from "./portal/pages/PortalReadingAssessmentDetail";
import PortalVideos from "./portal/pages/PortalVideos";
import PortalVideoDetail from "./portal/pages/PortalVideoDetail";
import AppLinkListener from "./portal/components/AppLinkListener";
import BackButtonHandler from "./portal/components/BackButtonHandler";
import CoachObservations from "./portal/pages/CoachObservations";
import CoachTeacherDetail from "./portal/pages/CoachTeacherDetail";

const queryClient = new QueryClient();

const App = () => {
  const { i18n } = useTranslation();
  // A `portal.` subdomain or the native app (src/lib/runtime.ts).
  const isPortalSubdomain = isPortalTarget();

  useEffect(() => {
    // Update the lang attribute on the HTML element
    const currentLang = i18n.language;
    document.documentElement.setAttribute('lang', currentLang);

    // Set direction for RTL languages
    if (currentLang === 'ar' || currentLang === 'ur') {
      document.documentElement.setAttribute('dir', 'rtl');
    } else {
      document.documentElement.setAttribute('dir', 'ltr');
    }

    // Wait for Google Fonts to load before rendering
    if (document.fonts) {
      document.fonts.ready.then(() => {
        console.log('Fonts loaded for language:', currentLang);
      });
    }
  }, [i18n.language]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          {/* Android app only; both are no-ops in a browser. */}
          <AppLinkListener />
          <BackButtonHandler />
          <Routes>
            {/* "/" is every app launch: send a signed-in teacher to their
                session (PortalRoot), not straight to the login form. */}
            <Route path="/" element={isPortalSubdomain ? <PortalRoot /> : <Index />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            
            {/* Portal Routes */}
          <Route path="/portal/setup/:token" element={<PortalSetup />} />
          <Route path="/portal/login" element={<PortalLogin />} />
          <Route path="/portal/reset-password" element={<PortalPasswordReset />} />
          <Route path="/portal/reset-password/verify" element={<PortalPasswordResetVerify />} />
          <Route path="/portal/dashboard" element={<PortalDashboard />} />
            <Route path="/portal/lesson-plans" element={<PortalLessonPlans />} />
            <Route path="/portal/coaching" element={<PortalCoaching />} />
            <Route path="/portal/coaching/analytics" element={<PortalCoachingAnalytics />} />
            <Route path="/portal/coaching/session/:sessionId" element={<PortalCoachingDetail />} />
            <Route path="/portal/reading-assessments" element={<PortalReadingAssessments />} />
            <Route path="/portal/reading-assessment/:id" element={<PortalReadingAssessmentDetail />} />
            <Route path="/portal/videos" element={<PortalVideos />} />
            <Route path="/portal/video/:id" element={<PortalVideoDetail />} />
            <Route path="/portal/observe" element={<CoachObservations />} />
            <Route path="/portal/observe/teacher/:id" element={<CoachTeacherDetail />} />

            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
