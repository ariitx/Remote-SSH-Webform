using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;

namespace TableVisualizerSample
{
    public class Address
    {
        public string City { get; set; }
        public string Country { get; set; }
    }

    public class Person
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public DateTime BirthDate { get; set; }
        public decimal Salary { get; set; }
        public bool Active { get; set; }
        public string Email { get; set; }
        public Address Address { get; set; }
        public List<string> Tags { get; set; }
        public Person Manager { get; set; }
    }

    public static class Program
    {
        public static void Main()
        {
            var people = new List<Person>
            {
                new Person { Id = 1, Name = "Ada Lovelace", BirthDate = new DateTime(1815, 12, 10), Salary = 1234.56m, Active = true, Email = "ada@example.com", Address = new Address { City = "London", Country = "UK" }, Tags = new List<string> { "math", "poetry" } },
                new Person { Id = 2, Name = "Grace \"Amazing\" Hopper", BirthDate = new DateTime(1906, 12, 9), Salary = 98765.4321m, Active = false, Email = null, Address = new Address { City = "New York", Country = "US" }, Tags = new List<string>() },
                new Person { Id = 3, Name = "Line\nbreak\tand \\ backslash", BirthDate = new DateTime(2000, 1, 1, 13, 45, 30), Salary = -5m, Active = true, Email = "ünïcødé@例え.jp 🎉" },
            };
            people[0].Manager = people[1];
            people[1].Manager = people[0]; // a reference cycle

            var bigList = Enumerable.Range(1, 5000)
                .Select(i => new Person { Id = i, Name = "Person " + i, BirthDate = new DateTime(1990, 1, 1).AddDays(i), Salary = i * 10.5m, Active = i % 2 == 0 })
                .ToList();

            var orders = new DataTable("Orders");
            orders.Columns.Add("OrderId", typeof(int));
            orders.Columns.Add("Customer", typeof(string));
            orders.Columns.Add("OrderDate", typeof(DateTime));
            orders.Columns.Add("Total", typeof(decimal));
            orders.Columns.Add("Shipped", typeof(bool));
            orders.Columns.Add("Notes", typeof(string));
            orders.Rows.Add(1001, "Contoso", new DateTime(2026, 9, 1), 250.75m, true, "Leave at the \"front\" door");
            orders.Rows.Add(1002, "Fabrikam", new DateTime(2026, 9, 2, 8, 30, 0), 1200m, false, DBNull.Value);
            orders.Rows.Add(1003, "Northwind | Traders", new DateTime(2026, 9, 3), 0.5m, DBNull.Value, "Multi\nline");

            var customers = new DataTable("Customers");
            customers.Columns.Add("Name", typeof(string));
            customers.Columns.Add("Country", typeof(string));
            customers.Rows.Add("Contoso", "US");
            customers.Rows.Add("Fabrikam", "DE");
            customers.Rows.Add("Litware", "FR");
            customers.AcceptChanges();
            customers.Rows[1].Delete(); // shown as a deleted row until AcceptChanges

            var emptyTable = new DataTable("Empty");
            emptyTable.Columns.Add("Id", typeof(int));
            emptyTable.Columns.Add("Description", typeof(string));

            var shop = new DataSet("Shop");
            shop.Tables.Add(orders);
            shop.Tables.Add(customers);

            var prices = new Dictionary<string, decimal> { ["apple"] = 1.25m, ["banana"] = 0.5m, ["cherry"] = 12m };
            var peopleById = people.ToDictionary(p => p.Id);
            int[] numbers = { 3, 1, 4, 1, 5, 9, 2, 6 };
            string[] words = { "alpha", null, "gamma" };
            IEnumerable<int> squares = Enumerable.Range(1, 20).Select(i => i * i);
            object boxedTable = orders;
            DataView cheapOrders = new DataView(orders, "Total < 1000", "Total", DataViewRowState.CurrentRows);

            List<Person> nobody = null;
            DataTable missingTable = null;

            Console.WriteLine($"{people.Count} people, {orders.Rows.Count} orders"); // BREAK 1: right-click a variable > Visualize as Table

            orders.Rows.Add(1004, "Adventure Works", new DateTime(2026, 9, 4), 99.99m, true, "Added after the first stop");
            people.Add(new Person { Id = 4, Name = "Alan Turing", BirthDate = new DateTime(1912, 6, 23), Salary = 4242m, Active = true });
            prices["durian"] = 30m;

            Console.WriteLine($"{people.Count} people, {orders.Rows.Count} orders"); // BREAK 2: step here; an open table refreshes

            GC.KeepAlive(new object[] { bigList, emptyTable, shop, prices, peopleById, numbers, words, squares, boxedTable, cheapOrders, nobody, missingTable });
        }
    }
}
