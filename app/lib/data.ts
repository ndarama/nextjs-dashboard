import postgres from 'postgres';
import {
  CustomerField,
  CustomersTableType,
  InvoiceForm,
  InvoicesTable,
  LatestInvoiceRaw,
  Revenue,
} from './definitions';
import { formatCurrency } from './utils';

const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' });

export async function fetchRevenue() {
  try {
    // Artificial delay only in development
    if (process.env.NODE_ENV !== 'production') {
      console.log('Fetching revenue data...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const data = await sql<Revenue[]>`SELECT * FROM revenue`;
    return data;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch revenue data.');
  }
}

export async function fetchLatestInvoices() {
  try {
    const data = await sql<LatestInvoiceRaw[]>`
      SELECT
        invoices.amount,
        customers.name,
        customers.image_url,
        customers.email,
        invoices.id
      FROM invoices
      JOIN customers ON invoices.customer_id = customers.id
      ORDER BY invoices.date DESC
      LIMIT 5
    `;

    // amount is stored as cents → formatCurrency likely expects major units or handles cents;
    // here we pass the raw numeric (ensure it's a number)
    const latestInvoices = data.map((invoice) => ({
      ...invoice,
      amount: formatCurrency(Number(invoice.amount)),
    }));

    return latestInvoices;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch the latest invoices.');
  }
}

export async function fetchCardData() {
  try {
    // Run in parallel
    const invoiceCountPromise = sql<{ count: string }[]>`
      SELECT COUNT(*)::bigint AS count FROM invoices
    `;
    const customerCountPromise = sql<{ count: string }[]>`
      SELECT COUNT(*)::bigint AS count FROM customers
    `;
    const invoiceStatusPromise = sql<{ paid: string | null; pending: string | null }[]>`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0)::bigint AS paid,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0)::bigint AS pending
      FROM invoices
    `;

    const [invCountRes, custCountRes, statusRes] = await Promise.all([
      invoiceCountPromise,
      customerCountPromise,
      invoiceStatusPromise,
    ]);

    const numberOfInvoices = Number(invCountRes[0]?.count ?? 0);
    const numberOfCustomers = Number(custCountRes[0]?.count ?? 0);
    const totalPaidInvoices = formatCurrency(Number(statusRes[0]?.paid ?? 0));
    const totalPendingInvoices = formatCurrency(Number(statusRes[0]?.pending ?? 0));

    return {
      numberOfCustomers,
      numberOfInvoices,
      totalPaidInvoices,
      totalPendingInvoices,
    };
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch card data.');
  }
}

const ITEMS_PER_PAGE = 6;

export async function fetchFilteredInvoices(
  query: string,
  currentPage: number,
) {
  const offset = (currentPage - 1) * ITEMS_PER_PAGE;

  try {
    const like = `%${query}%`;

    const invoices = await sql<InvoicesTable[]>`
      SELECT
        invoices.id,
        invoices.amount,
        invoices.date,
        invoices.status,
        customers.name,
        customers.email,
        customers.image_url
      FROM invoices
      JOIN customers ON invoices.customer_id = customers.id
      WHERE
        customers.name ILIKE ${like} OR
        customers.email ILIKE ${like} OR
        invoices.amount::text ILIKE ${like} OR
        invoices.date::text ILIKE ${like} OR
        invoices.status ILIKE ${like}
      ORDER BY invoices.date DESC
      LIMIT ${ITEMS_PER_PAGE} OFFSET ${offset}
    `;

    return invoices;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch invoices.');
  }
}

export async function fetchInvoicesPages(query: string) {
  try {
    const like = `%${query}%`;

    const data = await sql<{ count: string }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM invoices
      JOIN customers ON invoices.customer_id = customers.id
      WHERE
        customers.name ILIKE ${like} OR
        customers.email ILIKE ${like} OR
        invoices.amount::text ILIKE ${like} OR
        invoices.date::text ILIKE ${like} OR
        invoices.status ILIKE ${like}
    `;

    const totalPages = Math.ceil(Number(data[0]?.count ?? 0) / ITEMS_PER_PAGE);
    return totalPages;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch total number of invoices.');
  }
}

export async function fetchInvoiceById(id: string) {
  try {
    const rows = await sql<InvoiceForm[]>`
      SELECT
        invoices.id,
        invoices.customer_id,
        invoices.amount,
        invoices.status
      FROM invoices
      WHERE invoices.id = ${id}
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) return undefined;

    return {
      ...row,
      // Convert amount from cents to major units for the form
      amount: Number(row.amount) / 100,
    } satisfies InvoiceForm;
  } catch (error) {
    console.error('Database Error:', error);
    throw new Error('Failed to fetch invoice.');
  }
}

export async function fetchCustomers() {
  try {
    const customers = await sql<CustomerField[]>`
      SELECT id, name
      FROM customers
      ORDER BY name ASC
    `;

    return customers;
  } catch (err) {
    console.error('Database Error:', err);
    throw new Error('Failed to fetch all customers.');
  }
}

export async function fetchFilteredCustomers(query: string) {
  try {
    const like = `%${query}%`;

    const data = await sql<CustomersTableType[]>`
      SELECT
        customers.id,
        customers.name,
        customers.email,
        customers.image_url,
        COUNT(invoices.id)::bigint AS total_invoices,
        COALESCE(SUM(CASE WHEN invoices.status = 'pending' THEN invoices.amount ELSE 0 END), 0)::bigint AS total_pending,
        COALESCE(SUM(CASE WHEN invoices.status = 'paid' THEN invoices.amount ELSE 0 END), 0)::bigint AS total_paid
      FROM customers
      LEFT JOIN invoices ON customers.id = invoices.customer_id
      WHERE
        customers.name ILIKE ${like} OR
        customers.email ILIKE ${like}
      GROUP BY customers.id, customers.name, customers.email, customers.image_url
      ORDER BY customers.name ASC
    `;

    const customers = data.map((customer) => ({
      ...customer,
      total_pending: formatCurrency(Number(customer.total_pending)),
      total_paid: formatCurrency(Number(customer.total_paid)),
    }));

    return customers;
  } catch (err) {
    console.error('Database Error:', err);
    throw new Error('Failed to fetch customer table.');
  }
}
