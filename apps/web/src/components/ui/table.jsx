import { cn } from '@/lib/utils';

/**
 * `scrollLabel`: for tables that may be wider than the screen. The scroll container becomes a
 * labelled, focusable region so keyboard users can scroll it (WCAG 2.1.1).
 */
const Table = ({ className, scrollLabel, ...props }) => (
  <div
    className="w-full overflow-x-auto rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    {...(scrollLabel ? { role: 'region', 'aria-label': scrollLabel, tabIndex: 0 } : {})}
  >
    <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
  </div>
);
const TableHeader = (props) => <thead className="border-b bg-muted/60 text-left text-xs font-medium text-muted-foreground" {...props} />;
const TableBody = (props) => <tbody className="divide-y" {...props} />;
const TableRow = ({ className, ...props }) => <tr className={cn('transition-colors hover:bg-muted/40', className)} {...props} />;
const TableHead = ({ className, ...props }) => <th scope="col" className={cn('h-10 px-4 font-medium whitespace-nowrap', className)} {...props} />;
const TableCell = ({ className, ...props }) => <td className={cn('px-4 py-3 align-middle', className)} {...props} />;

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
