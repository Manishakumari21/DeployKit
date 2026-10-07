import { Router } from "express";
import {
  createDomainController,
  deleteDomainController,
  getDomainController,
  listDomainsController,
  verifyDomainController,
} from "../controllers/domainController.js";
import {
  requireDomainRouteAccess,
  requireProjectAccess,
} from "../middleware/auth.js";
import { requireTrustedOrigin } from "../middleware/origin.js";

const router = Router();

// Browser state changers pass the origin check first (safe methods skip it
// internally), matching project/deployment routers.
router.use(requireTrustedOrigin);

// Project-scoped routes: membership decided on the URL project id.
router.post("/projects/:id/domains", requireProjectAccess, createDomainController);
router.get("/projects/:id/domains", requireProjectAccess, listDomainsController);

// Domain-scoped routes: middleware resolves the owning project first.
router.get("/domains/:id", requireDomainRouteAccess, getDomainController);
router.post("/domains/:id/verify", requireDomainRouteAccess, verifyDomainController);
router.delete("/domains/:id", requireDomainRouteAccess, deleteDomainController);

export default router;
