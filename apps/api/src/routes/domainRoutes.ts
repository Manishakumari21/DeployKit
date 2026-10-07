import { Router } from "express";
import {
  createDomainController,
  deleteDomainController,
  getDomainController,
  listDomainsController,
  requestCertificateController,
  verifyDomainController,
} from "../controllers/domainController.js";
import {
  requireDomainRouteAccess,
  requireProjectAccess,
} from "../middleware/auth.js";
import { requireTrustedOrigin } from "../middleware/origin.js";

const router = Router();

router.use(requireTrustedOrigin);

router.post("/projects/:id/domains", requireProjectAccess, createDomainController);
router.get("/projects/:id/domains", requireProjectAccess, listDomainsController);

router.get("/domains/:id", requireDomainRouteAccess, getDomainController);
router.post("/domains/:id/verify", requireDomainRouteAccess, verifyDomainController);
router.post("/domains/:id/certificate", requireDomainRouteAccess, requestCertificateController);
router.delete("/domains/:id", requireDomainRouteAccess, deleteDomainController);

export default router;
