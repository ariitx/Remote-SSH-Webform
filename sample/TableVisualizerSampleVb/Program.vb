Imports System.Data

Public Class Item
    Public Property Code As String
    Public Property Quantity As Integer
End Class

Module Program
    Sub Main()
        Dim items As New List(Of Item) From {
            New Item With {.Code = "A-1", .Quantity = 3},
            New Item With {.Code = "B-2", .Quantity = 7}
        }

        Dim stock As New DataTable("Stock")
        stock.Columns.Add("Code", GetType(String))
        stock.Columns.Add("OnHand", GetType(Integer))
        stock.Rows.Add("A-1", 10)
        stock.Rows.Add("B-2", DBNull.Value)

        Console.WriteLine(items.Count & " items, " & stock.Rows.Count & " rows") ' BREAK 1

        GC.KeepAlive(items)
        GC.KeepAlive(stock)
    End Sub
End Module
