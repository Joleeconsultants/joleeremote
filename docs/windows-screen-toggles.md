## Windows screen toggles

HiDPI now applies Set to Best Fit using the new pixel-density choice. The request carries that choice explicitly so startup preference delivery cannot select a different density. The PC still chooses from its supported Windows display modes; exact presets retain their advertised dimensions. The toggle is disabled while the catalog is unavailable, a transition is pending, resizing is unavailable, or CSS scaling is locked.

Force Aligned Resolution stays visible but locked off on the Windows catalog path. Windows modes are never rounded to encoder alignment. Re-enable only when a future display path advertises compatible custom sizes.

Validation: display-catalog/DPI tests, TypeScript check, production dashboard build and Edge dashboard fixture (unknown capability, disabled alignment, HiDPI dispatch and preference update). No native rebuild required.
